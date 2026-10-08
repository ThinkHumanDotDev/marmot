/**
 * socket.io server of the realtime process.
 *
 * - Authenticates every connection with the Payload session cookie (`payload.auth`) and rejects
 *   anonymous sockets in the handshake (`connect_error: unauthorized`).
 * - Joins the socket to `org:<id>` for each organization the user belongs to and sends that
 *   organization's initial state (`monitorList`, `heartbeatList`, `importantHeartbeatList`,
 *   `uptime`, `avgPing`) plus `info`.
 * - `joinOrg` / `leaveOrg` let a client subscribe to further organizations; membership is checked
 *   again (superadmins may join any organization).
 *
 * Live events are published by the web and worker processes through `emitter.ts` and reach
 * this server via the Redis adapter.
 */
import type { Server as HttpServer } from 'node:http'
import { Server, type ServerOptions, type Socket } from 'socket.io'
import type { Payload } from 'payload'

import { getUserOrgIds, isSuperadmin } from '@/access/permissions'
import { childLogger } from '@/lib/logger'
import { MARMOT_VERSION } from '@/lib/version'
import type { User } from '@/payload-types'
import {
  orgRoom,
  RealtimeClientEvents,
  RealtimeEvents,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from './events'
import { loadOrgState, parseDocId } from './state'

const log = childLogger('realtime')

export interface SocketData {
  user: User
}

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>
export type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>

export interface CreateRealtimeServerOptions {
  payload: Payload
  httpServer: HttpServer
  /** socket.io adapter (production: `@socket.io/redis-adapter`). */
  adapter?: ServerOptions['adapter']
  cors?: ServerOptions['cors']
  /** Reported in the `info` event (default: package.json's version). */
  version?: string
  /** Further socket.io options (tests: `connectTimeout`, transports …). */
  serverOptions?: Partial<ServerOptions>
}

/** Build WHATWG `Headers` from the handshake so `payload.auth` can read the cookie. */
export function headersFromHandshake(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  return headers
}

/** May this user receive events of `organizationId`? */
export function canJoinOrg(user: User, organizationId: string | number): boolean {
  if (isSuperadmin(user)) return true
  const wanted = String(organizationId)
  return getUserOrgIds(user).some((id) => String(id) === wanted)
}

export function createRealtimeServer(options: CreateRealtimeServerOptions): RealtimeServer {
  const { payload, httpServer } = options
  const version = options.version ?? MARMOT_VERSION

  const io: RealtimeServer = new Server(httpServer, {
    cors: options.cors,
    adapter: options.adapter,
    ...options.serverOptions,
  })

  // ---- Authentication ------------------------------------------------------------------------
  // Browsers send `Origin` on the WebSocket upgrade and the polling requests; Payload only accepts
  // the cookie when that origin is on its CSRF allowlist (`serverURL`, i.e. the web app origin).
  io.use(async (socket, next) => {
    try {
      const headers = headersFromHandshake(socket.handshake.headers)
      const { user } = await payload.auth({ headers, canSetHeaders: false })
      if (!user || user.collection !== 'users') {
        return next(new Error('unauthorized'))
      }
      socket.data.user = user
      next()
    } catch (err) {
      log.warn({ err, id: socket.id }, 'socket authentication failed')
      next(new Error('unauthorized'))
    }
  })

  // ---- Initial state -------------------------------------------------------------------------
  async function sendOrgState(socket: RealtimeSocket, organizationId: string | number) {
    const state = await loadOrgState(payload, organizationId, { overrideAccess: true })
    const orgId = state.organizationId
    socket.emit(RealtimeEvents.monitorList, { organizationId: orgId, monitors: state.monitors })
    for (const monitor of state.monitors) {
      const monitorId = monitor.id
      socket.emit(RealtimeEvents.heartbeatList, {
        organizationId: orgId,
        monitorId,
        heartbeats: state.heartbeats[monitorId] ?? [],
      })
      socket.emit(RealtimeEvents.importantHeartbeatList, {
        organizationId: orgId,
        monitorId,
        heartbeats: state.importantHeartbeats[monitorId] ?? [],
      })
      for (const [range, value] of Object.entries(state.uptime[monitorId] ?? {})) {
        if (value === undefined) continue
        socket.emit(RealtimeEvents.uptime, {
          organizationId: orgId,
          monitorId,
          range: range as keyof (typeof state.uptime)[string],
          value,
        })
      }
      for (const [range, value] of Object.entries(state.avgPing[monitorId] ?? {})) {
        if (value === undefined) continue
        socket.emit(RealtimeEvents.avgPing, {
          organizationId: orgId,
          monitorId,
          range: range as keyof (typeof state.avgPing)[string],
          value,
        })
      }
    }
  }

  async function joinOrg(socket: RealtimeSocket, organizationId: string | number) {
    const room = orgRoom(organizationId)
    const alreadyJoined = socket.rooms.has(room)
    await socket.join(room)
    if (!alreadyJoined) await sendOrgState(socket, organizationId)
  }

  // ---- Connections ---------------------------------------------------------------------------
  io.on('connection', async (socket) => {
    const user = socket.data.user
    log.debug({ id: socket.id, userId: user.id }, 'socket connected')

    socket.emit(RealtimeEvents.info, { version, serverTime: new Date().toISOString() })

    socket.on(RealtimeClientEvents.joinOrg, async (organizationId, ack) => {
      try {
        if (!canJoinOrg(user, organizationId)) {
          ack?.({ ok: false, error: 'forbidden' })
          return
        }
        if (isSuperadmin(user)) {
          // Superadmins may watch any organization, but only one that exists.
          const exists = await payload
            .findByID({
              collection: 'organizations',
              id: parseDocId(payload, organizationId),
              depth: 0,
              overrideAccess: true,
              disableErrors: true,
            })
            .catch(() => null)
          if (!exists) {
            ack?.({ ok: false, error: 'not found' })
            return
          }
        }
        await joinOrg(socket, organizationId)
        ack?.({ ok: true })
      } catch (err) {
        log.error({ err, id: socket.id, organizationId }, 'joinOrg failed')
        ack?.({ ok: false, error: 'internal error' })
      }
    })

    socket.on(RealtimeClientEvents.leaveOrg, (organizationId) => {
      void socket.leave(orgRoom(organizationId))
    })

    socket.on('disconnect', (reason) => {
      log.debug({ id: socket.id, reason }, 'socket disconnected')
    })

    for (const organizationId of getUserOrgIds(user)) {
      try {
        await joinOrg(socket, organizationId)
      } catch (err) {
        log.error({ err, id: socket.id, organizationId }, 'failed to send organization state')
      }
    }
  })

  return io
}
