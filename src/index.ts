import express from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
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

const JWT_SECRET = process.env.JWT_SECRET || 'ptqutmjmkjsmqpu35jowt8nhqtgglua1'

// Authentication middleware
io.use((socket: Socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization

  if (!token) {
    return next(new Error('Authentication error: Token missing'))
  }

  try {
    const cleanToken = token.replace('Bearer ', '')
    const decoded = jwt.verify(cleanToken, JWT_SECRET);
    (socket as any).user = decoded
    next()
  } catch (err) {
    next(new Error('Authentication error: Invalid token'))
  }
})

io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id)

  socket.on('join_room', (roomId: string) => {
    console.log(`Socket ${socket.id} joining room: ${roomId}`)
    socket.join(roomId)
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
