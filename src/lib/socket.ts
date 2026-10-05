/**
 * Browser-side socket.io client: one shared, lazily created socket per page.
 *
 * The socket authenticates with the `payload-token` cookie (`withCredentials`), so it must be
 * same-site with the web app. By default it connects to the page's own origin where Caddy routes
 * `/socket.io/*` to the realtime process; `NEXT_PUBLIC_REALTIME_URL` points it elsewhere when
 * the realtime server lives on another origin (then that origin must allow the web origin in
 * CORS, which `src/realtime.ts` does for `NEXT_PUBLIC_SERVER_URL`).
 */
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client'

import type { ClientToServerEvents, ServerToClientEvents } from '@/server/realtime/events'

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export const SOCKET_PATH = '/socket.io'

let socket: RealtimeSocket | undefined

/**
 * Origin of the realtime server, or `undefined` for the page origin. `NEXT_PUBLIC_*` variables are
 * inlined by Next.js at build time, so this must read `process.env` directly (the zod-validated
 * `src/env.ts` is server-only).
 */
export function realtimeUrl(): string | undefined {
  const url = process.env.NEXT_PUBLIC_REALTIME_URL
  return url && url.trim().length > 0 ? url.trim().replace(/\/+$/, '') : undefined
}

export function socketOptions(): Partial<ManagerOptions & SocketOptions> {
  return {
    path: SOCKET_PATH,
    withCredentials: true,
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 15_000,
    randomizationFactor: 0.5,
  }
}

/** The shared socket (not connected until `connect()` is called, see `SocketProvider`). */
export function getSocket(): RealtimeSocket {
  if (!socket) {
    const url = realtimeUrl()
    const options = socketOptions()
    socket = url ? io(url, options) : io(options)
  }
  return socket
}

/** Drop the shared socket (tests, or after a logout). */
export function resetSocket(): void {
  socket?.disconnect()
  socket = undefined
}
