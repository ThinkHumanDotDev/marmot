/**
 * Minimal Docker Engine API client for the `docker` monitor type and the "test connection" endpoint.
 *
 * Ported from Uptime Kuma 3.0.0-beta.0 `server/docker.js` (`DockerHost.testDockerHost`,
 * `DockerHost.patchDockerURL`) and the `docker` branch of `server/model/monitor.js` — Copyright (c)
 * 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md. Uses undici instead of axios; TLS client
 * certificates (Uptime Kuma's `DOCKER_TLS_DIR_PATH`) are not supported yet.
 */
import { Agent, request } from 'undici'

import { env } from '@/env'
import type { DockerHost } from '@/payload-types'
import { assertHostLocalAllowed, guardedAgent } from '@/server/security/outbound-guard'

export type DockerHostConfig = Pick<DockerHost, 'connectionType' | 'socketPath' | 'url'>

/** Subset of `GET /containers/{id}/json` → `State` the monitor looks at. */
export interface DockerContainerState {
  Status?: string
  Running?: boolean
  Paused?: boolean
  Restarting?: boolean
  Health?: { Status?: string }
}

/**
 * axios (and undici) do not accept `tcp://`; the Docker CLI does. Rewrite it to `http://`
 * (https://github.com/louislam/uptime-kuma/issues/2165).
 */
export const patchDockerURL = (url: string) => url.replace(/^tcp:\/\//i, 'http://')

/**
 * GET `path` from the daemon described by `host` and parse the JSON body. Throws with the daemon's
 * `message` on a non-2xx response.
 */
export async function dockerRequest<T>(
  host: DockerHostConfig,
  path: string,
  signal: AbortSignal,
): Promise<T> {
  let origin: string
  let agent: Agent
  if (host.connectionType === 'tcp') {
    if (!host.url) throw new Error('The Docker host has no URL')
    origin = patchDockerURL(host.url).replace(/\/+$/, '')
    // The daemon URL is user input: connections pass the outbound address guard.
    agent = guardedAgent({ rejectUnauthorized: true, maxCachedSessions: 0 })
  } else {
    if (!env.DOCKER_SOCKET_ENABLED) {
      throw new Error('Socket Docker hosts are disabled on this instance (DOCKER_SOCKET_ENABLED)')
    }
    // The worker's own daemon is host-local: refused while private addresses are denied.
    assertHostLocalAllowed('A Docker socket host')
    if (!host.socketPath) throw new Error('The Docker host has no socket path')
    origin = 'http://localhost'
    agent = new Agent({ connect: { socketPath: host.socketPath } })
  }

  try {
    const res = await request(`${origin}${path}`, {
      method: 'GET',
      headers: { accept: '*/*' },
      signal,
      dispatcher: agent,
    })
    const text = await res.body.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Only the daemon's JSON `message` is echoed, never an arbitrary response body.
      const message =
        body &&
        typeof body === 'object' &&
        typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message.slice(0, 200)
          : ''
      throw new Error(`Docker API returned ${res.statusCode}${message ? `: ${message}` : ''}`)
    }
    if (body === null) throw new Error('Invalid Docker response, is it really a Docker daemon?')
    return body as T
  } finally {
    await agent.close().catch(() => {})
  }
}

/** Number of containers on the host (`testDockerHost`). Throws when the daemon is unreachable. */
export async function testDockerHost(host: DockerHostConfig, timeoutMs = 6000): Promise<number> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const data = await dockerRequest<unknown>(host, '/containers/json?all=true', signal)
    if (!Array.isArray(data)) {
      throw new Error('Invalid Docker response, is it really a Docker daemon?')
    }
    if (data.length > 0 && !(data[0] && typeof data[0] === 'object' && 'ImageID' in data[0])) {
      throw new Error('Invalid Docker response, is it really a Docker daemon?')
    }
    return data.length
  } catch (error) {
    if (signal.aborted) throw new Error('Connection to Docker daemon timed out.')
    throw error
  }
}

export type ContainerVerdict =
  | { status: 'up'; msg: string }
  | { status: 'pending'; msg: string }
  | { status: 'down'; msg: string }

/** Map a container state to a heartbeat (the `docker` branch of `Monitor.beat`). */
export function containerVerdict(state: DockerContainerState | undefined | null): ContainerVerdict {
  if (!state) return { status: 'down', msg: 'Container state is not available' }
  if (!state.Running)
    return { status: 'down', msg: `Container State is ${state.Status ?? 'unknown'}` }
  if (state.Paused) return { status: 'down', msg: 'Container is in a paused state' }
  if (state.Restarting) {
    return { status: 'pending', msg: 'Container is reporting it is currently restarting' }
  }
  const health = state.Health?.Status
  if (health && health !== 'none') {
    if (health === 'healthy') return { status: 'up', msg: 'healthy' }
    if (health === 'unhealthy') {
      return { status: 'down', msg: 'Container State is unhealthy according to its healthcheck' }
    }
    return { status: 'pending', msg: health }
  }
  return {
    status: 'up',
    msg: `Container has not reported health and is currently ${state.Status ?? 'running'}. As it is running, it is considered UP. Consider adding a health check for better service visibility`,
  }
}
