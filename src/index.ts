import express from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import { Client } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

const app = express()
app.use(cors())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'changeme'

// Authentication middleware (Shared Secret)
io.use((socket: Socket, next) => {
  const secret = socket.handshake.auth.secret || socket.handshake.headers['x-bridge-secret']

  if (!secret) {
    return next(new Error('Authentication error: Secret missing'))
  }

  if (secret !== BRIDGE_SECRET) {
    console.warn(`[Bridge Auth] Invalid secret from socket ${socket.id}`)
    return next(new Error('Authentication error: Invalid secret'))
  }

  console.log(`[Bridge Auth] Client authenticated: ${socket.id}`)
  next()
})

io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id)

  socket.on('join_room', (roomId: string) => {
    console.log(`Socket ${socket.id} joining room: ${roomId}`)
    socket.join(roomId)
  })

  // Bidirectional Broadcast (Typing, Presence, Instant Notifications)
  socket.on('broadcast', (data: any) => {
    const { channelId, event, payload } = data
    if (!channelId || !event) return

    console.log(`[Broadcast] ${event} from ${socket.id} to room ${channelId}`)

    // Relay to the specific room
    socket.to(channelId).emit('broadcast', { channelId, event, payload })

    // Optional: Relay to admin-hub if it's a message-related event
    if (event === 'new_message' || event === 'typing') {
      socket.to('admin-hub').emit('broadcast', { channelId, event, payload })
    }
  })

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id)
  })
})

// Postgres Listener Setup
async function setupPgListener () {
  const pgClient = new Client({
    connectionString: process.env.DATABASE_URL
  })

  try {
    await pgClient.connect()
    console.log('Connected to Postgres for LISTEN')

    // Listen to chat_messages channel (requires a trigger in DB)
    await pgClient.query('LISTEN chat_messages')

    pgClient.on('notification', (msg) => {
      console.log('DB Notification received on channel:', msg.channel)
      if (msg.payload) {
        try {
          const payload = JSON.parse(msg.payload)
          const { channel_id: channelId } = payload

          if (channelId) {
            console.log(`Broadcasting to room ${channelId}`)
            // Broadcast to specific room
            io.to(channelId).emit('new_message', payload)
            // Also broadcast to a global hub if needed
            io.to('admin-hub').emit('admin_message', payload)
          }
        } catch (e) {
          console.error('Error parsing DB payload:', e)
        }
      }
    })

    pgClient.on('error', (err) => {
      console.error('Postgres unexpected client error:', err)
      pgClient.end().catch(() => {})
      setTimeout(setupPgListener, 5000)
    })
  } catch (err) {
    console.error('Postgres listener connection error:', err)
    pgClient.end().catch(() => {})
    setTimeout(setupPgListener, 5000) // Retry after 5s
  }
}

setupPgListener()

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`Realtime Bridge listening on port ${PORT}`)
})
