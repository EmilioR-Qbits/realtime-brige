import express from 'express'
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'
import cors from 'cors'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import * as dotenv from 'dotenv'
import axios from 'axios'

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
const LARAVEL_API_URL = process.env.VITE_APP_API_URL || 'https://api-orderwise-dev.qbitsinc.com/api'

// Authentication middleware (Dual: JWT & Laravel Sanctum)
io.use(async (socket: Socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.authorization

  if (!token) {
    return next(new Error('Authentication error: Token missing'))
  }

  const cleanToken = token.replace('Bearer ', '')

  // 1. Detección por formato: JWT (Supabase) suele empezar por eyJ
  if (cleanToken.startsWith('eyJ')) {
    try {
      const decoded = jwt.verify(cleanToken, JWT_SECRET)
      ;(socket as any).user = decoded
      return next()
    } catch (err) {
      return next(new Error('Authentication error: Invalid JWT token'))
    }
  }

  // 2. Si no es JWT, asumimos que es un token de Laravel Sanctum (estilo 1361|...)
  // Lo validamos contra el backend de Laravel
  try {
    const response = await axios.get(`${LARAVEL_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: 'application/json'
      }
    })

    if (response.status === 200) {
      (socket as any).user = response.data
      console.log(`User authenticated via Laravel: ${response.data.email || response.data.id}`)
      return next()
    }
    next(new Error('Authentication error: Invalid Sanctum token'))
  } catch (err) {
    console.error('Laravel auth validation failed:', (err as any).message)
    next(new Error('Authentication error: Backend validation failed'))
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
