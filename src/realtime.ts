/**
 * Realtime entrypoint: socket.io server backed by the Redis adapter.
 * Runs as its own process so the Next.js app can keep `output: 'standalone'`-style builds.
 * Run with `pnpm dev:realtime` (payload run) or `pnpm start:realtime`.
 */
import 'dotenv/config'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { createRedis } from '@/server/redis'

const log = childLogger('realtime')

async function main() {
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const pub = createRedis()
  const sub = pub.duplicate()

  const io = new Server(httpServer, {
    cors: { origin: env.NEXT_PUBLIC_SERVER_URL, credentials: true },
    adapter: createAdapter(pub, sub),
  })

  io.on('connection', (socket) => {
    log.debug({ id: socket.id }, 'socket connected')
    socket.on('disconnect', (reason) => log.debug({ id: socket.id, reason }, 'socket disconnected'))
  })

  httpServer.listen(env.REALTIME_PORT, () => {
    log.info({ port: env.REALTIME_PORT }, 'realtime server listening')
  })

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'realtime shutting down')
    io.close()
    pub.disconnect()
    sub.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.fatal(err, 'realtime failed to start')
  process.exit(1)
})
