import { describe, expect, it } from 'vitest'

import {
  applyRecoveryThreshold,
  computeNextBeat,
  flipStatus,
  isImportantBeat,
  isImportantForNotification,
  nextIntervalSeconds,
  type BeatStatus,
  type CheckResult,
  type MonitorSettings,
  type NextState,
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

describe('recovery threshold (#147)', () => {
  const s = settings({ successThreshold: 3, maxRetries: 2 })
  const down: NextState = computeNextBeat({ status: 'pending', retries: 2 }, fail(), s)

  it('threshold 1 (default) keeps the Uptime Kuma path', () => {
    expect(
      applyRecoveryThreshold({ status: 'down' }, { status: 'up', msg: 'OK', retries: 0 }, {}),
    ).toMatchObject({ status: 'up', recoveries: 0, previousStatus: 'down' })
    const next = computeNextBeat(
      { status: 'down', retries: 5 },
      ok(),
      settings({ successThreshold: 1 }),
    )
    expect(next).toMatchObject({ status: 'up', important: true, notify: true, recoveries: 0 })
  })

  it('needs N consecutive successes; the beats in between are PENDING "Recovering n/N"', () => {
    expect(down).toMatchObject({ status: 'down', retries: 3, notify: true })

    const r1 = computeNextBeat(down, ok(), s)
    expect(r1).toMatchObject({
      status: 'pending',
      msg: 'Recovering 1/3: 200 - OK',
      recoveries: 1,
      retries: 3,
      important: false,
      notify: false,
      nextIntervalSeconds: 20,
    })
    const r2 = computeNextBeat(r1, ok(), s)
    expect(r2).toMatchObject({ status: 'pending', msg: 'Recovering 2/3: 200 - OK', recoveries: 2 })
    const up = computeNextBeat(r2, ok(), s)
    expect(up).toMatchObject({
      status: 'up',
      msg: '200 - OK',
      recoveries: 0,
      retries: 0,
      important: true,
      notify: true,
    })
  })

  it('a failure during recovery goes straight back to DOWN, silently, and resets the count', () => {
    const r1 = computeNextBeat(down, ok(), s)
    const again = computeNextBeat(r1, fail('flap'), s)
    expect(again).toMatchObject({
      status: 'down',
      msg: 'flap',
      recoveries: 0,
      important: false,
      notify: false,
    })
    const r1b = computeNextBeat(again, ok(), s)
    expect(r1b).toMatchObject({ status: 'pending', recoveries: 1 })
  })

  it('a flapping service produces one DOWN and one UP notification', () => {
    const pattern = [false, true, false, true, true, false, true, true, true, true]
    let state: NextState = computeNextBeat({ status: 'up', retries: 0 }, fail(), {
      ...s,
      maxRetries: 0,
    })
    const notified: string[] = [state.status]
    for (const success of pattern) {
      state = computeNextBeat(state, success ? ok() : fail(), { ...s, maxRetries: 0 })
      if (state.notify) notified.push(state.status)
    }
    expect(notified).toEqual(['down', 'up'])
    expect(state.status).toBe('up')
  })

  it('does not apply to PENDING retries from UP or to the first beat', () => {
    const retry = computeNextBeat({ status: 'up', retries: 0 }, fail(), s)
    expect(retry).toMatchObject({ status: 'pending', recoveries: 0 })
    expect(computeNextBeat(retry, ok(), s)).toMatchObject({ status: 'up', important: false })
    expect(computeNextBeat(null, ok(), s)).toMatchObject({ status: 'up', isFirstBeat: true })
  })

  it('a failure during recovery does not start a new retry round even if retries were reset', () => {
    const next = computeNextBeat({ status: 'pending', retries: 0, recoveries: 2 }, fail(), s)
    expect(next).toMatchObject({ status: 'down', important: false, notify: false })
  })

  it('maintenance ends the streak like it ends an outage', () => {
    const r1 = computeNextBeat(down, ok(), s)
    const maintenance = computeNextBeat(r1, { ok: false, msg: 'x', underMaintenance: true }, s)
    expect(maintenance).toMatchObject({ status: 'maintenance', recoveries: 0, important: true })
  })

  it('counts upside-down successes (a failing check) towards recovery', () => {
    const u = settings({ upsideDown: true, successThreshold: 2 })
    const r1 = computeNextBeat({ status: 'down', retries: 1 }, fail('refused'), u)
    expect(r1).toMatchObject({ status: 'pending', msg: 'Recovering 1/2: refused', recoveries: 1 })
    expect(computeNextBeat(r1, fail('refused'), u)).toMatchObject({ status: 'up', notify: true })
  })

  it('reminders are not counted while recovering', () => {
    const r = settings({ successThreshold: 2, resendInterval: 2 })
    let state = computeNextBeat({ status: 'down', retries: 1, downCount: 1 }, ok(), r)
    expect(state).toMatchObject({ status: 'pending', downCount: 1 })
    state = computeNextBeat(state, fail(), r)
    expect(state).toMatchObject({ status: 'down', downCount: 0, notify: true })
  })
})
