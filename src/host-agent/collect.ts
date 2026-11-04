/**
 * Host agent collectors (#136): one `HostSample` (`src/lib/host-metrics.ts`) per call, from Node's
 * `os` module plus what the platform offers on top:
 *
 * - CPU busy share from `os.cpus()` deltas between two samples (every platform);
 * - load averages (`os.loadavg()`, not on Windows);
 * - memory from `/proc/meminfo` on Linux (`MemAvailable`, like `free`), `os.freemem()` elsewhere;
 * - swap from `/proc/meminfo` on Linux and `sysctl vm.swapusage` on macOS;
 * - disks with `fs.statfs` (used and total like `df`: reserved blocks are not counted as free);
 * - network throughput from `/proc/net/dev` deltas on Linux and `netstat -ib` on macOS;
 * - temperatures from `/sys/class/hwmon` (or `/sys/class/thermal`) on Linux.
 *
 * With `root` (`HOST_AGENT_ROOT`, e.g. `/host` when the host's `/` is mounted into the agent's
 * container) `/proc`, `/sys`, `/etc` and the mount points are read under it, and the network
 * counters of the host's PID 1, so the figures are the host's rather than the container's.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HostSample } from '@/lib/host-metrics'

type CpuTimes = { idle: number; total: number }
type NetCounters = { rx: number; tx: number; at: number }

export interface CollectorOptions {
  /** Mount points to report; default `/` (every fixed drive letter on Windows). */
  disks?: string[]
  /** Prefix of the host's filesystem (`HOST_AGENT_ROOT`). */
  root?: string
  agentVersion?: string
  platform?: NodeJS.Platform
}

const readText = (file: string): Promise<string | null> => readFile(file, 'utf8').catch(() => null)

const run = (command: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout),
    )
  })

/** `os.cpus()` summed over all cores. */
function cpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** `/proc/meminfo` in kB → bytes, keyed by field name. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line)
    if (match) out[match[1]] = Number(match[2]) * 1024
  }
  return out
}

/** Received and sent bytes over every interface but loopback, from `/proc/net/dev`. */
export function parseProcNetDev(text: string): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':')
    if (!rest || name.trim() === 'lo') continue
    const fields = rest.trim().split(/\s+/).map(Number)
    rx += fields[0] || 0
    tx += fields[8] || 0
  }
  return { rx, tx }
}

/** Same from macOS `netstat -ib`: one `<Link#n>` row per interface carries its byte counters. */
export function parseNetstat(text: string): { rx: number; tx: number } | null {
  const lines = text.trim().split('\n')
  const header = lines[0]?.trim().split(/\s+/) ?? []
  const ib = header.indexOf('Ibytes')
  const ob = header.indexOf('Obytes')
  if (ib < 0 || ob < 0) return null
  let rx = 0
  let tx = 0
  const seen = new Set<string>()
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (!cols[2]?.startsWith('<Link') || cols[0].startsWith('lo') || seen.has(cols[0])) continue
    seen.add(cols[0])
    // Rows without an address have one column fewer than the header.
    const shift = cols.length < header.length ? -1 : 0
    rx += Number(cols[ib + shift]) || 0
    tx += Number(cols[ob + shift]) || 0
  }
  return { rx, tx }
}

/** macOS `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.25M  free = …`. */
export function parseSwapusage(text: string): { used: number; total: number } | null {
  const unit = (n: string, u: string) =>
    Number(n) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[u] ?? 1)
  const total = /total = ([\d.]+)([KMG])/.exec(text)
  const used = /used = ([\d.]+)([KMG])/.exec(text)
  if (!total || !used) return null
  return { total: unit(total[1], total[2]), used: unit(used[1], used[2]) }
}

export class HostCollector {
  private readonly root: string
  private readonly platform: NodeJS.Platform
  private readonly disks: string[]
  private readonly agentVersion: string | null
  private prevCpu: CpuTimes | null = null
  private prevNet: NetCounters | null = null
  private osName: string | null = null

  constructor(options: CollectorOptions = {}) {
    this.root = options.root ? path.resolve(options.root) : ''
    this.platform = options.platform ?? process.platform
    this.disks =
      options.disks && options.disks.length > 0
        ? options.disks
        : this.platform === 'win32'
          ? []
          : ['/']
    this.agentVersion = options.agentVersion ?? null
    this.prevCpu = cpuTimes()
  }

  private host(file: string): string {
    return this.root ? path.join(this.root, file) : file
  }

  async collect(now: number = Date.now()): Promise<HostSample> {
    const [memory, swap, disks, network, temperatures, osName, hostname] = await Promise.all([
      this.memory(),
      this.swap(),
      this.diskUsage(),
      this.network(now),
      this.temperatures(),
      this.operatingSystem(),
      this.hostname(),
    ])
    return {
      hostname,
      platform: this.platform,
      arch: process.arch,
      os: osName,
      agentVersion: this.agentVersion,
      uptime: Math.round(os.uptime()),
      cpus: os.cpus().length,
      cpu: this.cpu(),
      load: this.platform === 'win32' ? null : (os.loadavg() as [number, number, number]),
      memory,
      swap,
      disks,
      network,
      temperatures,
    }
  }

  private cpu(): number | null {
    const current = cpuTimes()
    const prev = this.prevCpu
    this.prevCpu = current
    if (!prev) return null
    const total = current.total - prev.total
    if (total <= 0) return null
    const busy = total - (current.idle - prev.idle)
    return Math.round(Math.min(100, Math.max(0, (busy / total) * 100)) * 10) / 10
  }

  private async meminfo(): Promise<Record<string, number> | null> {
    if (this.platform !== 'linux') return null
    const text = await readText(this.host('/proc/meminfo'))
    return text ? parseMeminfo(text) : null
  }

  private async memory(): Promise<{ used: number; total: number }> {
    const info = await this.meminfo()
    if (info?.MemTotal && info.MemAvailable !== undefined) {
      return { total: info.MemTotal, used: info.MemTotal - info.MemAvailable }
    }
    const total = os.totalmem()
    return { total, used: total - os.freemem() }
  }

  private async swap(): Promise<{ used: number; total: number } | null> {
    if (this.platform === 'linux') {
      const info = await this.meminfo()
      if (!info || info.SwapTotal === undefined) return null
      return { total: info.SwapTotal, used: info.SwapTotal - (info.SwapFree ?? 0) }
    }
    if (this.platform === 'darwin') {
      const text = await run('sysctl', ['-n', 'vm.swapusage'])
      return text ? parseSwapusage(text) : null
    }
    return null
  }

  private async mountPoints(): Promise<string[]> {
    if (this.disks.length > 0 || this.platform !== 'win32') return this.disks
    // Every drive letter that answers statfs.
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`)
    const found = await Promise.all(
      letters.map((drive) =>
        statfs(drive).then(
          () => drive,
          () => null,
        ),
      ),
    )
    return found.filter((d): d is string => d !== null)
  }

  private async diskUsage(): Promise<{ mount: string; used: number; total: number }[]> {
    const out: { mount: string; used: number; total: number }[] = []
    for (const mount of await this.mountPoints()) {
      try {
        const stats = await statfs(this.host(mount))
        const used = (stats.blocks - stats.bfree) * stats.bsize
        out.push({ mount, used, total: used + stats.bavail * stats.bsize })
      } catch {
        // Not mounted (yet): skipped until it is.
      }
    }
    return out
  }

  private async counters(): Promise<{ rx: number; tx: number } | null> {
    if (this.platform === 'linux') {
      // The host's network namespace is PID 1's when /proc is the host's.
      const file = this.root ? this.host('/proc/1/net/dev') : '/proc/net/dev'
      const text = await readText(file)
      return text ? parseProcNetDev(text) : null
    }
    if (this.platform === 'darwin') {
      const text = await run('netstat', ['-ib'])
      return text ? parseNetstat(text) : null
    }
    return null
  }

  private async network(now: number): Promise<{ rx: number; tx: number } | null> {
    const current = await this.counters()
    if (!current) return null
    const prev = this.prevNet
    this.prevNet = { ...current, at: now }
    if (!prev || now <= prev.at) return null
    const seconds = (now - prev.at) / 1000
    // Counters reset (reboot, interface gone): skip one sample rather than report a negative rate.
    if (current.rx < prev.rx || current.tx < prev.tx) return null
    return {
      rx: Math.round((current.rx - prev.rx) / seconds),
      tx: Math.round((current.tx - prev.tx) / seconds),
    }
  }

  private async temperatures(): Promise<{ name: string; celsius: number }[]> {
    if (this.platform !== 'linux') return []
    const out: { name: string; celsius: number }[] = []
    const used = new Set<string>()
    const add = (name: string, milli: string | null) => {
      const value = Number(milli?.trim())
      if (!milli || !Number.isFinite(value) || value === 0) return
      let unique = name
      for (let n = 2; used.has(unique); n++) unique = `${name}-${n}`
      used.add(unique)
      out.push({ name: unique, celsius: Math.round(value / 100) / 10 })
    }
    const hwmon = this.host('/sys/class/hwmon')
    for (const dir of await readdir(hwmon).catch(() => [] as string[])) {
      const base = path.join(hwmon, dir)
      const chip = (await readText(path.join(base, 'name')))?.trim() || dir
      const files = await readdir(base).catch(() => [] as string[])
      for (const file of files.filter((f) => /^temp\d+_input$/.test(f)).sort()) {
        const label = (await readText(path.join(base, file.replace('_input', '_label'))))?.trim()
        add(label ? `${chip} ${label}` : chip, await readText(path.join(base, file)))
      }
    }
    if (out.length > 0) return out.slice(0, 64)
    const thermal = this.host('/sys/class/thermal')
    for (const dir of await readdir(thermal).catch(() => [] as string[])) {
      if (!dir.startsWith('thermal_zone')) continue
      const type = (await readText(path.join(thermal, dir, 'type')))?.trim() || dir
      add(type, await readText(path.join(thermal, dir, 'temp')))
    }
    return out.slice(0, 64)
  }

  private async operatingSystem(): Promise<string> {
    if (this.osName) return this.osName
    let name: string | null = null
    if (this.platform === 'linux') {
      const release = await readText(this.host('/etc/os-release'))
      name = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release ?? '')?.[1] ?? null
    }
    this.osName = name ?? `${os.type()} ${os.release()}`
    return this.osName
  }

  private async hostname(): Promise<string> {
    if (this.root) {
      const name = (await readText(this.host('/etc/hostname')))?.trim()
      if (name) return name.slice(0, 255)
    }
    return os.hostname().slice(0, 255) || 'unknown'
  }
}
