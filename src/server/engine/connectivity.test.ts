import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { describe, expect, it, vi } from 'vitest'

import { connectivityTargetsError, parseConnectivityTargets } from '@/lib/connectivity-targets'
import { computeNextBeat, type MonitorSettings } from './beat'
import {
  ConnectivityMonitor,
  isLocalHost,
  probeConnectivity,
  probeTarget,
  type ConnectivityConfig,
} from './connectivity'
import { CheckerNoticeOutbox, renderCheckerNotice } from './connectivity-runtime'
import { summarizeCheckerStates } from './connectivity-state'

const settings: MonitorSettings = { interval: 60, retryInterval: 20, maxRetries: 2 }

const config = (over: Partial<ConnectivityConfig> = {}): ConnectivityConfig => ({
  targets: parseConnectivityTargets('1.1.1.1:53, 8.8.8.8:53'),
  mode: 'any',
  intervalMs: 30_000,
  timeoutMs: 100,
  ...over,
})

describe('CONNECTIVITY_CHECK_TARGETS', () => {
  it('parses host:port, [v6]:port and URLs', () => {
    expect(
      parseConnectivityTargets('1.1.1.1:53 [2606:4700::1111]:53, https://example.com/x'),
    ).toEqual([
      { kind: 'tcp', label: '1.1.1.1:53', host: '1.1.1.1', port: 53 },
      { kind: 'tcp', label: '[2606:4700::1111]:53', host: '2606:4700::1111', port: 53 },
      { kind: 'http', label: 'https://example.com/x', url: 'https://example.com/x' },
    ])
  })

  it('rejects malformed entries and empty lists', () => {
    expect(connectivityTargetsError('1.1.1.1')).toMatch(/host:port/)
    expect(connectivityTargetsError('1.1.1.1:0')).toMatch(/port/)
    expect(connectivityTargetsError(' , ')).toMatch(/at least one/)
    expect(connectivityTargetsError('1.1.1.1:53,https://ok.example')).toBeNull()
  })
})

describe('holding a beat while the checker is offline', () => {
  it('is PENDING, silent and keeps retries, downCount and cadence of the previous status', () => {
    const result = { ok: false, msg: 'checker offline', checkerOffline: true }
    const fromDown = computeNextBeat({ status: 'down', retries: 4, downCount: 2 }, result, {
      ...settings,
      resendInterval: 1,
    })
    expect(fromDown).toMatchObject({
      status: 'pending',
      msg: 'checker offline',
      retries: 4,
      downCount: 2,
      important: false,
      notify: false,
      isFirstBeat: false,
      nextIntervalSeconds: 60,
    })
    // A monitor in a retry streak keeps polling at its retry interval.
    expect(
      computeNextBeat({ status: 'pending', retries: 1 }, result, settings).nextIntervalSeconds,
    ).toBe(20)
    // Even the very first beat is not announced.
    expect(computeNextBeat(null, result, settings)).toMatchObject({
      isFirstBeat: true,
      notify: false,
    })
  })
})

describe('probing', () => {
  it('applies the any / all rule', async () => {
    const prober = vi.fn(async (target: { label: string }) => {
      if (target.label.startsWith('8.8.8.8')) throw new Error('unreachable')
    })
    const any = await probeConnectivity(config(), prober)
    expect(any.online).toBe(true)
    expect(any.results.map((r) => r.ok)).toEqual([true, false])
    expect((await probeConnectivity(config({ mode: 'all' }), prober)).online).toBe(false)
  })

  it('connects to a TCP target and fails on a closed port', async () => {
    const server = net.createServer((s) => s.end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      await expect(
        probeTarget({ kind: 'tcp', label: 'x', host: '127.0.0.1', port }, 1000),
      ).resolves.toBeUndefined()
    } finally {
      await new Promise((r) => server.close(r))
    }
    await expect(
      probeTarget({ kind: 'tcp', label: 'x', host: '127.0.0.1', port }, 1000),
    ).rejects.toThrow()
  })
})

describe('ConnectivityMonitor', () => {
  it('caches the verdict, shares concurrent probes and reports changes', async () => {
    let now = 0
    let online = true
    const prober = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      if (!online) throw new Error('down')
    })
    const onChange = vi.fn()
    const monitor = new ConnectivityMonitor({
      config: config({ targets: parseConnectivityTargets('1.1.1.1:53') }),
      prober,
      now: () => new Date(now),
      onChange,
    })
    expect(monitor.snapshot().status).toBe('unknown')

    const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()])
    expect(a).toEqual(b)
    expect(prober).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'online' }),
      'unknown',
    )

    // Fresh enough: no new probe.
    now = 10_000
    online = false
    expect((await monitor.refresh()).status).toBe('online')
    expect(prober).toHaveBeenCalledTimes(1)

    // A shorter max age forces one.
    const offline = await monitor.refresh({ maxAgeMs: 5_000 })
    expect(offline).toMatchObject({ status: 'offline', since: new Date(10_000).toISOString() })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'offline' }),
      'online',
    )

    monitor.markHeld(3)
    monitor.markHeld('3')
    monitor.markHeld(4)
    expect(monitor.takeHeld()).toEqual(['3', '4'])
    expect(monitor.takeHeld()).toEqual([])
  })
})

describe('local targets', () => {
  it('classifies by name or address without resolving when possible', async () => {
    const resolve = vi.fn(async () => ['10.1.2.3'])
    expect(await isLocalHost('127.0.0.1', resolve)).toBe(true)
    expect(await isLocalHost('[fd00::1]', resolve)).toBe(true)
    expect(await isLocalHost('printer', resolve)).toBe(true)
    expect(await isLocalHost('nas.home.arpa', resolve)).toBe(true)
    expect(await isLocalHost('8.8.8.8', resolve)).toBe(false)
    expect(resolve).not.toHaveBeenCalled()

    expect(await isLocalHost('intranet.example.com', resolve)).toBe(true)
    expect(await isLocalHost('example.com', async () => ['10.0.0.1', '93.184.216.34'])).toBe(false)
    expect(
      await isLocalHost('example.com', async () => {
        throw new Error('ENOTFOUND')
      }),
    ).toBe(false)
  })
})

describe('checker state summary', () => {
  const state = (
    location: string,
    status: 'online' | 'offline' | 'unknown',
    since: string | null,
  ) => ({
    location,
    worker: `${location}-${status}`,
    status,
    since,
    checkedAt: since,
  })

  it('is offline when any worker is, with the earliest outage start', () => {
    expect(summarizeCheckerStates([])).toEqual({ status: 'unknown', since: null, locations: [] })
    expect(
      summarizeCheckerStates([
        state('eu', 'online', '2026-10-07T09:00:00Z'),
        state('us', 'offline', '2026-10-07T10:05:00Z'),
        state('ap', 'offline', '2026-10-07T10:00:00Z'),
      ]),
    ).toEqual({
      status: 'offline',
      since: '2026-10-07T10:00:00Z',
      locations: [
        { location: 'ap', status: 'offline', since: '2026-10-07T10:00:00Z' },
        { location: 'eu', status: 'online', since: '2026-10-07T09:00:00Z' },
        { location: 'us', status: 'offline', since: '2026-10-07T10:05:00Z' },
      ],
    })
    expect(summarizeCheckerStates([state('eu', 'online', null)]).status).toBe('online')
  })
})

describe('checker notices', () => {
  it('renders the offline and back-online messages', () => {
    const offline = renderCheckerNotice({
      kind: 'offline',
      location: 'default',
      at: '2026-10-07T10:00:00.000Z',
      results: [{ target: '1.1.1.1:53', ok: false, ms: null, error: 'timeout' }],
    })
    expect(offline.subject).toBe('Marmot checker offline')
    expect(offline.text).toContain('Oct 7, 2026')
    expect(offline.text).not.toContain('location default')
    expect(offline.text).toContain('1.1.1.1:53 failed (timeout)')

    const online = renderCheckerNotice({
      kind: 'online',
      location: 'eu-west',
      at: '2026-10-07T10:30:00.000Z',
      offlineSince: '2026-10-07T10:00:00.000Z',
    })
    expect(online.subject).toBe('Marmot checker back online')
    expect(online.text).toContain('(location eu-west)')
    expect(online.text).toContain('30 minutes offline')
  })

  it('retries undelivered notices in order', async () => {
    let fail = true
    const delivered: string[] = []
    const outbox = new CheckerNoticeOutbox(async (notice) => {
      if (fail) throw new Error('smtp unreachable')
      delivered.push(notice.kind)
    })
    outbox.push({ kind: 'offline', location: 'default', at: '2026-10-07T10:00:00Z' })
    outbox.push({ kind: 'online', location: 'default', at: '2026-10-07T10:30:00Z' })
    await outbox.flush()
    expect(outbox.size).toBe(2)
    fail = false
    await outbox.flush()
    expect(delivered).toEqual(['offline', 'online'])
    expect(outbox.size).toBe(0)
  })
})
