import express from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import { Client, Pool } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'changeme'
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
const PG_RECONNECT_DELAY_MS = 5000

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

// ─── HTTP & Socket.io Setup ───────────────────────────────────────────────────

const app = express()
app.use(cors({ origin: ALLOWED_ORIGIN }))
app.use(express.json())

/** Health check endpoint for Dokploy / load balancer probes */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) })
})

/**
 * Endpoint for n8n or other external services to mark messages as read.
 * This updates the database and broadcasts the event via Socket.io.
 * URL: POST /mark-read
 * Body: { channelId: string, role?: string, userId?: string }
 */
app.post('/mark-read', async (req, res) => {
  const secret = req.headers['x-bridge-secret'] || req.body.secret
  if (secret !== BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Secret mismatch or missing' })
  }

  const { channelId, role, userId } = req.body
  if (!channelId) {
    return res.status(400).json({ error: 'Missing channelId' })
  }

  try {
    // 1. Update database: Mark as read messages in this channel
    // We can filter by role or by sender_user_id (if provided)
    let query = 'UPDATE chat_messages SET is_read = true WHERE channel_id = $1 AND is_read = false'
    const params = [channelId]

    if (role) {
      query += ' AND role = $2'
      params.push(role)
    } else if (userId) {
      query += ' AND sender_user_id = $2'
      params.push(userId)
    }

    const result = await pool.query(query, params)

    console.log(`[HTTP] Marked ${result.rowCount} messages as read in channel ${channelId}`)

    // 2. Broadcast the event via Socket.io
    // This allows the UI to update the checkmarks/unread indicators immediately
    io.to(channelId).emit('broadcast', {
      channelId,
      event: 'messages_read',
      payload: { channelId, role, userId }
    })

    // Also notify admin-hub for visibility
    io.to('admin-hub').emit('broadcast', {
      channelId,
      event: 'messages_read',
      payload: { channelId, role, userId }
    })

    res.json({
      success: true,
      rowsUpdated: result.rowCount
    })
  } catch (err) {
    console.error('[Error] /mark-read failed:', err)
    res.status(500).json({ error: 'Internal server error while updating chat_messages' })
  }
})

/**
 * Endpoint for n8n or other external services to trigger a "typing" status.
 * URL: POST /typing
 * Body: { channelId: string, isTyping: boolean, userId?: string }
 */
app.post('/typing', (req, res) => {
  const secret = req.headers['x-bridge-secret'] || req.body.secret
  if (secret !== BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { channelId, isTyping, userId } = req.body
  if (!channelId) {
    return res.status(400).json({ error: 'Missing channelId' })
  }

  // Broadcast typing status to the room
  io.to(channelId).emit('broadcast', {
    channelId,
    event: 'typing',
    payload: { userId: userId || 'assistant', isTyping, channelId }
  })

  // Mirror to admin-hub
  io.to('admin-hub').emit('broadcast', {
    channelId,
    event: 'typing',
    payload: { userId: userId || 'assistant', isTyping, channelId }
  })

  res.json({ success: true })
})

const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST']
  }
})

// ─── Authentication Middleware (Shared Secret) ────────────────────────────────

io.use((socket: Socket, next) => {
  const secret =
    socket.handshake.auth.secret ||
    socket.handshake.headers['x-bridge-secret']

  if (!secret) return next(new Error('Authentication error: Secret missing'))
  if (secret !== BRIDGE_SECRET) {
    console.warn(`[Auth] Invalid secret from socket ${socket.id}`)
    return next(new Error('Authentication error: Invalid secret'))
  }

  console.log(`[Auth] Client authenticated: ${socket.id}`)
  next()
})

// ─── Socket.io Event Handlers ─────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  console.log(`[Socket] Connected: ${socket.id}`)

  socket.on('join_room', (roomId: string) => {
    if (!roomId) return
    console.log(`[Socket] ${socket.id} joined room: ${roomId}`)
    socket.join(roomId)
  })

  /**
   * Bidirectional broadcast (typing indicators, instant message delivery, presence).
   * The sender is excluded from the specific-room relay to avoid echo.
   * Admin-hub receives all message and typing events to guarantee full visibility.
   */
  socket.on('broadcast', (data: { channelId?: string; event?: string; payload?: unknown }) => {
    const { channelId, event, payload } = data
    if (!channelId || !event) return

    console.log(`[Broadcast] ${event} from ${socket.id} → room ${channelId}`)

    // Relay to the specific chat room (exclude sender to avoid echo)
    socket.to(channelId).emit('broadcast', { channelId, event, payload })

    // Mirror message and typing events to the admin hub for global visibility
    if (event === 'new_message' || event === 'typing') {
      socket.to('admin-hub').emit('broadcast', { channelId, event, payload })
    }
  })

  socket.on('disconnect', reason => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`)
  })
})

// ─── Postgres LISTEN/NOTIFY ───────────────────────────────────────────────────

async function setupPgListener (): Promise<void> {
  const pgClient = new Client({
    connectionString: process.env.DATABASE_URL
  })

  try {
    await pgClient.connect()

    // Register listener BEFORE the LISTEN query to ensure no notifications are missed
    pgClient.on('notification', msg => {
      console.log(`[PG] Raw notification from channel "${msg.channel}"`)
      if (!msg.payload) {
        console.warn('[PG] Empty payload received')
        return
      }

      try {
        const payload = JSON.parse(msg.payload)
        const channelId: string | undefined = payload.channel_id

        if (!channelId) {
          console.warn('[PG] No channel_id in payload:', payload)
          return
        }

        console.log(`[PG] Success: Dispatching to room ${channelId} and admin-hub`)
        io.to(channelId).emit('new_message', payload)
        io.to('admin-hub').emit('new_message', payload)
      } catch (e) {
        console.error('[PG] Error parsing notification payload:', e)
        console.error('[PG] Original payload:', msg.payload)
      }
    })

    console.log('[PG] Connected, listening on "new_message" channel')
    await pgClient.query('LISTEN new_message')

    pgClient.on('error', err => {
      console.error('[PG] Unexpected client error:', err)
      pgClient.end().catch(() => {})
      setTimeout(setupPgListener, PG_RECONNECT_DELAY_MS)
    })

    // Register cleanup for graceful shutdown
    pgCleanup = async () => {
      await pgClient.end()
      console.log('[PG] Connection closed')
    }
  } catch (err) {
    console.error('[PG] Connection error:', err)
    pgClient.end().catch(() => {})
    setTimeout(setupPgListener, PG_RECONNECT_DELAY_MS)
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let pgCleanup: (() => Promise<void>) | null = null

async function shutdown (signal: string): Promise<void> {
  console.log(`\n[Server] ${signal} received — shutting down gracefully`)
  io.close()
  httpServer.close()
  if (pgCleanup) await pgCleanup()
  await pool.end()
  console.log('[Server] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ─── Bootstrap ───────────────────────────────────────────────────────────────

setupPgListener()

httpServer.listen(PORT, () => {
  console.log(`[Server] Realtime Bridge listening on port ${PORT}`)
})
