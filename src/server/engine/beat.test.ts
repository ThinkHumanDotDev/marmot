import { describe, expect, it } from 'vitest'

import {
  computeNextBeat,
  degradedMessage,
  flipStatus,
  isDegradedTransition,
  isImportantBeat,
  isImportantForNotification,
  nextIntervalSeconds,
  notificationEventFor,
  type BeatStatus,
  type CheckResult,
  type MonitorSettings,
} from './beat'

const settings = (over: Partial<MonitorSettings> = {}): MonitorSettings => ({
  interval: 60,
  retryInterval: 20,
  maxRetries: 0,
  resendInterval: 0,
  upsideDown: false,
  ...over,
})

const ok = (msg = '200 - OK', ping = 12): CheckResult => ({ ok: true, status: 'up', msg, ping })
const fail = (msg = 'Connection failed'): CheckResult => ({ ok: false, msg })

describe('flipStatus', () => {
  it('swaps up and down and leaves the rest alone', () => {
    expect(flipStatus('up')).toBe('down')
    expect(flipStatus('down')).toBe('up')
    expect(flipStatus('pending')).toBe('pending')
    expect(flipStatus('maintenance')).toBe('maintenance')
  })
})

describe('isImportantBeat', () => {
  const statuses: BeatStatus[] = ['up', 'down', 'pending', 'maintenance']

  it('treats the first beat as important whatever the status', () => {
    for (const s of statuses) expect(isImportantBeat(true, undefined, s)).toBe(true)
  })

  it.each<[BeatStatus, BeatStatus, boolean]>([
    ['up', 'pending', false],
    ['up', 'down', true],
    ['up', 'up', false],
    ['pending', 'pending', false],
    ['pending', 'down', true],
    ['pending', 'up', false],
    ['down', 'down', false],
    ['down', 'up', true],
    ['maintenance', 'maintenance', false],
    ['maintenance', 'up', true],
    ['maintenance', 'down', true],
    ['down', 'maintenance', true],
    ['up', 'maintenance', true],
    ['pending', 'maintenance', false],
  ])('%s -> %s important=%s', (prev, curr, expected) => {
    expect(isImportantBeat(false, prev, curr)).toBe(expected)
  })
})

describe('isImportantForNotification', () => {
  it.each<[BeatStatus, BeatStatus, boolean]>([
    ['up', 'pending', false],
    ['up', 'down', true],
    ['up', 'up', false],
    ['pending', 'pending', false],
    ['pending', 'down', true],
    ['pending', 'up', false],
    ['down', 'down', false],
    ['down', 'up', true],
    ['maintenance', 'maintenance', false],
    ['maintenance', 'up', false],
    ['maintenance', 'down', true],
    ['down', 'maintenance', false],
    ['up', 'maintenance', false],
  ])('%s -> %s notify=%s', (prev, curr, expected) => {
    expect(isImportantForNotification(false, prev, curr)).toBe(expected)
  })

  it('is true on the first beat', () => {
    expect(isImportantForNotification(true, undefined, 'up')).toBe(true)
  })
})

describe('nextIntervalSeconds', () => {
  it('uses retryInterval only while pending', () => {
    expect(nextIntervalSeconds('pending', settings())).toBe(20)
    expect(nextIntervalSeconds('up', settings())).toBe(60)
    expect(nextIntervalSeconds('down', settings())).toBe(60)
    expect(nextIntervalSeconds('pending', settings({ retryInterval: 0 }))).toBe(60)
    expect(nextIntervalSeconds('up', settings({ interval: 0 }))).toBe(1)
  })
})

describe('computeNextBeat', () => {
  it('first successful beat is important but not notified', () => {
    const next = computeNextBeat(null, ok(), settings())
    expect(next).toMatchObject({
      status: 'up',
      msg: '200 - OK',
      ping: 12,
      retries: 0,
      downCount: 0,
      important: true,
      notify: false,
      isFirstBeat: true,
      nextIntervalSeconds: 60,
    })
  })

  it('first failing beat is important and notified', () => {
    const next = computeNextBeat(undefined, fail('boom'), settings())
    expect(next).toMatchObject({
      status: 'down',
      msg: 'boom',
      retries: 1,
      important: true,
      notify: true,
      isFirstBeat: true,
    })
  })

  it('UP -> UP is not important', () => {
    const next = computeNextBeat({ status: 'up', retries: 0, downCount: 0 }, ok(), settings())
    expect(next.important).toBe(false)
    expect(next.notify).toBe(false)
    expect(next.status).toBe('up')
  })

  it('UP -> DOWN without retries is important and notified', () => {
    const next = computeNextBeat({ status: 'up', retries: 0, downCount: 0 }, fail(), settings())
    expect(next).toMatchObject({ status: 'down', retries: 1, important: true, notify: true })
  })

  it('goes PENDING while retries remain, then DOWN', () => {
    const s = settings({ maxRetries: 2 })
    const b1 = computeNextBeat({ status: 'up', retries: 0, downCount: 0 }, fail(), s)
    expect(b1).toMatchObject({
      status: 'pending',
      retries: 1,
      important: false,
      notify: false,
      nextIntervalSeconds: 20,
    })

    const b2 = computeNextBeat(b1, fail(), s)
    expect(b2).toMatchObject({ status: 'pending', retries: 2, important: false, notify: false })

    const b3 = computeNextBeat(b2, fail(), s)
    expect(b3).toMatchObject({
      status: 'down',
      retries: 3,
      important: true,
      notify: true,
      nextIntervalSeconds: 60,
    })

    // retries keep counting while DOWN
    const b4 = computeNextBeat(b3, fail(), s)
    expect(b4).toMatchObject({ status: 'down', retries: 4, important: false, notify: false })
  })

  it('PENDING -> UP recovers silently and resets retries', () => {
    const next = computeNextBeat({ status: 'pending', retries: 1, downCount: 0 }, ok(), settings())
    expect(next).toMatchObject({ status: 'up', retries: 0, important: false, notify: false })
  })

  it('DOWN -> UP is important and notified', () => {
    const next = computeNextBeat({ status: 'down', retries: 5, downCount: 2 }, ok(), settings())
    expect(next).toMatchObject({
      status: 'up',
      retries: 0,
      downCount: 0,
      important: true,
      notify: true,
    })
  })

  it('re-notifies every resendInterval beats while DOWN', () => {
    const s = settings({ resendInterval: 3 })
    let state = computeNextBeat({ status: 'up', retries: 0, downCount: 0 }, fail(), s)
    expect(state).toMatchObject({ status: 'down', important: true, notify: true, downCount: 0 })

    state = computeNextBeat(state, fail(), s)
    expect(state).toMatchObject({ notify: false, downCount: 1 })
    state = computeNextBeat(state, fail(), s)
    expect(state).toMatchObject({ notify: false, downCount: 2 })
    state = computeNextBeat(state, fail(), s)
    expect(state).toMatchObject({ notify: true, downCount: 0, important: false })
    state = computeNextBeat(state, fail(), s)
    expect(state).toMatchObject({ notify: false, downCount: 1 })
  })

  it('does not count down beats when resendInterval is 0', () => {
    const state = computeNextBeat({ status: 'down', retries: 2, downCount: 0 }, fail(), settings())
    expect(state).toMatchObject({ downCount: 0, notify: false })
  })

  it('upside down: a failed check is UP', () => {
    const next = computeNextBeat(
      { status: 'up', retries: 0, downCount: 0 },
      fail('refused'),
      settings({ upsideDown: true, maxRetries: 3 }),
    )
    expect(next).toMatchObject({ status: 'up', msg: 'refused', retries: 0, important: false })
  })

  it('upside down: a successful check is DOWN ("Flip UP to DOWN"), honouring retries', () => {
    const s = settings({ upsideDown: true, maxRetries: 1 })
    const b1 = computeNextBeat({ status: 'up', retries: 0, downCount: 0 }, ok(), s)
    expect(b1).toMatchObject({ status: 'pending', msg: 'Flip UP to DOWN', retries: 1 })
    const b2 = computeNextBeat(b1, ok(), s)
    expect(b2).toMatchObject({ status: 'down', msg: 'Flip UP to DOWN', retries: 2, notify: true })
  })

  it('maintenance overrides the check and is important but silent from UP', () => {
    const next = computeNextBeat(
      { status: 'up', retries: 0, downCount: 0 },
      { ok: false, msg: 'ignored', underMaintenance: true },
      settings(),
    )
    expect(next).toMatchObject({
      status: 'maintenance',
      msg: 'Monitor under maintenance',
      important: true,
      notify: false,
      retries: 0,
    })
  })

  it('MAINTENANCE -> DOWN notifies, MAINTENANCE -> UP does not', () => {
    const prev = { status: 'maintenance' as BeatStatus, retries: 0, downCount: 0 }
    expect(computeNextBeat(prev, fail(), settings())).toMatchObject({
      status: 'down',
      important: true,
      notify: true,
    })
    expect(computeNextBeat(prev, ok(), settings())).toMatchObject({
      status: 'up',
      important: true,
      notify: false,
    })
  })

  it('accepts custom statuses from the check (groups, manual)', () => {
    const next = computeNextBeat(
      { status: 'up', retries: 0, downCount: 0 },
      { ok: true, status: 'pending', msg: 'Group empty' },
      settings(),
    )
    expect(next).toMatchObject({
      status: 'pending',
      msg: 'Group empty',
      important: false,
      nextIntervalSeconds: 20,
    })

    const down = computeNextBeat(
      { status: 'up', retries: 0, downCount: 0 },
      { ok: true, status: 'down', msg: 'Down' },
      settings({ maxRetries: 3 }),
    )
    // custom DOWN bypasses the retry ladder: the check decided, not a failure
    expect(down).toMatchObject({ status: 'down', retries: 0, important: true, notify: true })
  })

  it('carries ping and duration through', () => {
    const next = computeNextBeat(null, { ok: false, msg: 'x', ping: 5, duration: 61 }, settings())
    expect(next.ping).toBe(5)
    expect(next.duration).toBe(61)
  })
})

describe('degraded state (#93)', () => {
  const slow = (ping = 900, msg = '200 - OK'): CheckResult => ({
    ok: true,
    status: 'up',
    msg,
    ping,
  })
  const degradedSettings = (over: Partial<MonitorSettings> = {}) =>
    settings({ type: 'http', degradedAfter: 500, ...over })

  it('a successful check slower than degradedAfter is DEGRADED, faster or equal is UP', () => {
    const prev = { status: 'up' as const, settledStatus: 'up' as const }
    const degraded = computeNextBeat(prev, slow(900), degradedSettings())
    expect(degraded).toMatchObject({
      status: 'degraded',
      ping: 900,
      retries: 0,
      important: true,
      notify: true,
      notificationEvent: 'degraded',
      settledStatus: 'degraded',
    })
    expect(degraded.msg).toBe(
      '200 - OK (response time 900 ms exceeds the degraded threshold of 500 ms)',
    )
    expect(computeNextBeat(prev, slow(500), degradedSettings()).status).toBe('up')
    expect(computeNextBeat(prev, slow(100), degradedSettings()).status).toBe('up')
  })

  it('is off without a threshold, with 0, for unsupported types and without a ping', () => {
    const prev = { status: 'up' as const }
    expect(computeNextBeat(prev, slow(), settings()).status).toBe('up')
    expect(computeNextBeat(prev, slow(), degradedSettings({ degradedAfter: 0 })).status).toBe('up')
    expect(computeNextBeat(prev, slow(), degradedSettings({ type: 'push' })).status).toBe('up')
    expect(computeNextBeat(prev, slow(), degradedSettings({ type: 'mysql' })).status).toBe('up')
    expect(
      computeNextBeat(prev, { ok: true, status: 'up', msg: 'OK', ping: null }, degradedSettings())
        .status,
    ).toBe('up')
  })

  it('DEGRADED -> DEGRADED is quiet, DEGRADED -> UP announces the end of the degradation', () => {
    const prev = { status: 'degraded' as const, settledStatus: 'degraded' as const }
    expect(computeNextBeat(prev, slow(), degradedSettings())).toMatchObject({
      status: 'degraded',
      important: false,
      notify: false,
      notificationEvent: null,
    })
    expect(computeNextBeat(prev, slow(100), degradedSettings())).toMatchObject({
      status: 'up',
      important: true,
      notificationEvent: 'degraded',
    })
  })

  it('DEGRADED -> DOWN is a down event, DOWN -> DEGRADED a recovery', () => {
    const down = computeNextBeat({ status: 'degraded' }, fail(), degradedSettings())
    expect(down).toMatchObject({ status: 'down', important: true, notificationEvent: 'down' })
    const back = computeNextBeat({ status: 'down', retries: 1 }, slow(), degradedSettings())
    expect(back).toMatchObject({
      status: 'degraded',
      retries: 0,
      important: true,
      notificationEvent: 'up',
    })
  })

  it('retries: a failure while DEGRADED goes PENDING first, then DOWN', () => {
    const s = degradedSettings({ maxRetries: 1 })
    const pending = computeNextBeat({ status: 'degraded', settledStatus: 'degraded' }, fail(), s)
    expect(pending).toMatchObject({
      status: 'pending',
      retries: 1,
      important: false,
      notify: false,
      settledStatus: 'degraded',
      nextIntervalSeconds: 20,
    })
    const down = computeNextBeat(pending, fail(), s)
    expect(down).toMatchObject({ status: 'down', important: true, notificationEvent: 'down' })
  })

  it('retries: leaving PENDING compares with the status before the retry streak', () => {
    const s = degradedSettings({ maxRetries: 2 })
    // DEGRADED -> PENDING -> UP: the degradation ended during the retries.
    expect(
      computeNextBeat({ status: 'pending', retries: 1, settledStatus: 'degraded' }, slow(100), s),
    ).toMatchObject({ status: 'up', important: true, notificationEvent: 'degraded', retries: 0 })
    // DEGRADED -> PENDING -> DEGRADED: nothing changed.
    expect(
      computeNextBeat({ status: 'pending', retries: 1, settledStatus: 'degraded' }, slow(), s),
    ).toMatchObject({ status: 'degraded', important: false, notify: false })
    // UP -> PENDING -> DEGRADED: the monitor became slow.
    expect(
      computeNextBeat({ status: 'pending', retries: 1, settledStatus: 'up' }, slow(), s),
    ).toMatchObject({ status: 'degraded', important: true, notificationEvent: 'degraded' })
    // UP -> PENDING -> UP stays silent (Uptime Kuma).
    expect(
      computeNextBeat({ status: 'pending', retries: 1, settledStatus: 'up' }, slow(100), s),
    ).toMatchObject({ status: 'up', important: false, notify: false })
  })

  it('remembers the settled status through a retry streak, and falls back for older monitors', () => {
    const s = degradedSettings({ maxRetries: 3 })
    const first = computeNextBeat({ status: 'degraded' }, fail(), s)
    expect(first.settledStatus).toBe('degraded')
    const second = computeNextBeat(first, fail(), s)
    expect(second).toMatchObject({ status: 'pending', settledStatus: 'degraded' })
    // A monitor stored before the field existed, already PENDING: no transition is invented.
    expect(computeNextBeat({ status: 'pending', retries: 1 }, slow(), s)).toMatchObject({
      status: 'degraded',
      important: false,
    })
  })

  it('maintenance overrides DEGRADED; leaving maintenance slow is a degraded event', () => {
    const into = computeNextBeat(
      { status: 'degraded' },
      { ok: false, msg: '', underMaintenance: true },
      degradedSettings(),
    )
    expect(into).toMatchObject({ status: 'maintenance', important: true, notify: false })
    const out = computeNextBeat({ status: 'maintenance' }, slow(), degradedSettings())
    expect(out).toMatchObject({
      status: 'degraded',
      important: true,
      notificationEvent: 'degraded',
    })
  })

  it('upside down ignores the threshold', () => {
    const s = degradedSettings({ upsideDown: true })
    expect(computeNextBeat({ status: 'down' }, fail('timeout'), s).status).toBe('up')
    expect(computeNextBeat({ status: 'up' }, slow(), s).status).toBe('down')
  })

  it('the first beat is never announced when DEGRADED', () => {
    expect(computeNextBeat(null, slow(), degradedSettings())).toMatchObject({
      status: 'degraded',
      isFirstBeat: true,
      important: true,
      notify: false,
    })
  })

  it('custom statuses from the check (groups) pass through', () => {
    const next = computeNextBeat(
      { status: 'up' },
      { ok: true, status: 'degraded', msg: 'Degraded child monitors: api' },
      settings({ type: 'group' }),
    )
    expect(next).toMatchObject({ status: 'degraded', msg: 'Degraded child monitors: api' })
  })

  it.each<[BeatStatus | undefined, BeatStatus, BeatStatus | null, boolean]>([
    ['up', 'degraded', null, true],
    ['degraded', 'up', null, true],
    ['degraded', 'down', null, true],
    ['down', 'degraded', null, true],
    ['maintenance', 'degraded', null, true],
    ['degraded', 'maintenance', null, true],
    ['degraded', 'pending', null, false],
    ['degraded', 'degraded', null, false],
    ['up', 'down', null, false],
    ['pending', 'degraded', 'up', true],
    ['pending', 'up', 'degraded', true],
    ['pending', 'degraded', 'degraded', false],
    ['pending', 'degraded', null, false],
    [undefined, 'degraded', null, false],
  ])('isDegradedTransition %s -> %s (settled %s) = %s', (prev, curr, settled, expected) => {
    expect(isDegradedTransition(prev, curr, settled)).toBe(expected)
  })

  it.each<[BeatStatus, BeatStatus, ReturnType<typeof notificationEventFor>]>([
    ['up', 'down', 'down'],
    ['down', 'up', 'up'],
    ['pending', 'down', 'down'],
    ['maintenance', 'down', 'down'],
    ['maintenance', 'up', null],
    ['up', 'maintenance', null],
    ['up', 'degraded', 'degraded'],
    ['degraded', 'up', 'degraded'],
    ['degraded', 'down', 'down'],
    ['down', 'degraded', 'up'],
    ['degraded', 'maintenance', null],
    ['maintenance', 'degraded', 'degraded'],
  ])('notificationEventFor %s -> %s = %s', (prev, curr, expected) => {
    expect(notificationEventFor(false, prev, curr)).toBe(expected)
  })

  it('degradedMessage reads well with and without a check message', () => {
    expect(degradedMessage('', 812.4, 500)).toBe(
      'Response time 812 ms exceeds the degraded threshold of 500 ms',
    )
  })
})

describe('notification events of the existing transitions', () => {
  it('first DOWN beat is down, DOWN -> UP is up, resends are reminders', () => {
    expect(computeNextBeat(null, fail(), settings()).notificationEvent).toBe('down')
    expect(computeNextBeat({ status: 'down' }, ok(), settings()).notificationEvent).toBe('up')
    const s = settings({ resendInterval: 1 })
    expect(computeNextBeat({ status: 'down', downCount: 0 }, fail(), s)).toMatchObject({
      notify: true,
      notificationEvent: 'reminder',
    })
  })
})
