/**
 * Per-container figures for the host agent (#136, `HOST_AGENT_DOCKER=true`): the running
 * containers and one `stats?stream=false` snapshot each, read from the Docker Engine API over the
 * daemon socket (`/var/run/docker.sock`, `//./pipe/docker_engine` on Windows). CPU is the share of
 * the host's cores (`docker stats` semantics, 100 % per core), memory excludes the page cache like
 * `docker stats`.
 */
import http from 'node:http'

import type { HostSample } from '@/lib/host-metrics'

type Container = NonNullable<HostSample['containers']>[number]

const MAX_CONTAINERS = 200
const CONCURRENCY = 4

export const defaultDockerSocket = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'

function getJson(socketPath: string, path: string, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 300) {
          reject(new Error(`Docker API ${path}: HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (err) {
          reject(err)
        }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path}: timed out`)))
    req.on('error', reject)
  })
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] }
    system_cpu_usage?: number
    online_cpus?: number
  }
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number }
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> }
}

/** CPU % and memory of one stats snapshot (`docker stats` formulas). */
export function containerFigures(
  stats: DockerStats,
): Pick<Container, 'cpu' | 'memoryUsed' | 'memoryLimit'> {
  const cpu = stats.cpu_stats
  const pre = stats.precpu_stats
  let cpuPercent: number | null = null
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0)
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0)
  if (cpu?.system_cpu_usage !== undefined && pre?.system_cpu_usage !== undefined) {
    const cores = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1
    cpuPercent =
      systemDelta > 0 && cpuDelta >= 0
        ? Math.round((cpuDelta / systemDelta) * cores * 1000) / 10
        : 0
  }
  const memory = stats.memory_stats
  let memoryUsed: number | null = null
  if (typeof memory?.usage === 'number') {
    // cgroup v2 reports `inactive_file`, v1 `total_inactive_file` (Docker CLI since 20.10).
    const cache = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0
    memoryUsed = Math.max(0, memory.usage - (cache < memory.usage ? cache : 0))
  }
  return { cpu: cpuPercent, memoryUsed, memoryLimit: memory?.limit ?? null }
}

/** Running containers with their figures; throws when the daemon cannot be reached. */
export async function collectContainers(socketPath: string): Promise<Container[]> {
  const list = (await getJson(socketPath, '/containers/json')) as {
    Id: string
    Names?: string[]
    State?: string
  }[]
  const running = list.slice(0, MAX_CONTAINERS)
  const out: Container[] = new Array(running.length)
  let next = 0
  const worker = async () => {
    while (next < running.length) {
      const index = next++
      const entry = running[index]
      const name = (entry.Names?.[0] ?? entry.Id.slice(0, 12)).replace(/^\//, '').slice(0, 255)
      try {
        const stats = (await getJson(
          socketPath,
          `/containers/${encodeURIComponent(entry.Id)}/stats?stream=false&one-shot=false`,
        )) as DockerStats
        out[index] = { name, state: entry.State ?? null, ...containerFigures(stats) }
      } catch {
        out[index] = { name, state: entry.State ?? null, cpu: null, memoryUsed: null }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, running.length) }, worker))
  return out.filter(Boolean)
}
