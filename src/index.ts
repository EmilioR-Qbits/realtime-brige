import express from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import { Client } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'changeme'
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
const PG_RECONNECT_DELAY_MS = 5000

// ─── HTTP & Socket.io Setup ───────────────────────────────────────────────────

const app = express()
app.use(cors({ origin: ALLOWED_ORIGIN }))

/** Health check endpoint for Dokploy / load balancer probes */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) })
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
