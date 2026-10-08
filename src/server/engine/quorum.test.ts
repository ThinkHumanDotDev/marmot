import { describe, expect, it } from 'vitest'

import { quorumNeeded } from '@/lib/probe-locations'

import { computeNextBeat, type BeatStatus } from './beat'
import {
  computeQuorumBeat,
  quorumMessage,
  quorumStatus,
  tallyLocations,
  voteOf,
  type LocationState,
} from './quorum'

const KEYS = ['a', 'b', 'c']

const states = (entries: Record<string, LocationState>) => new Map(Object.entries(entries))
const st = (lastStatus: BeatStatus, extra: Partial<LocationState> = {}): LocationState => ({
  lastStatus,
  ...extra,
})

describe('quorumNeeded', () => {
  it('derives the threshold from the mode', () => {
    expect(quorumNeeded('any', 3)).toBe(1)
    expect(quorumNeeded('half', 3)).toBe(2)
    expect(quorumNeeded('half', 4)).toBe(2)
    expect(quorumNeeded('half', 2)).toBe(1)
    expect(quorumNeeded(undefined, 5)).toBe(3)
    expect(quorumNeeded('all', 3)).toBe(3)
    expect(quorumNeeded('all', 1)).toBe(1)
  })
})

describe('voteOf', () => {
  it('counts a recovery streak as down and a retry as retrying', () => {
    expect(voteOf(st('pending', { recoveries: 1 }))).toBe('down')
    expect(voteOf(st('pending'))).toBe('retrying')
    expect(voteOf(null)).toBe('unknown')
    expect(voteOf(st('degraded'))).toBe('degraded')
  })
})

describe('quorumStatus', () => {
  const status = (
    entries: Record<string, LocationState>,
    mode = 'half' as const,
    current?: BeatStatus,
  ) => quorumStatus(tallyLocations(KEYS, states(entries), mode), current ?? null)

  it('stays UP with one failing location of three and goes DOWN with two (default quorum)', () => {
    expect(status({ a: st('up'), b: st('up'), c: st('down') })).toBe('up')
    expect(status({ a: st('up'), b: st('down'), c: st('down') })).toBe('down')
  })

  it('honours any and all', () => {
    expect(status({ a: st('up'), b: st('up'), c: st('down') }, 'any' as never)).toBe('down')
    expect(status({ a: st('up'), b: st('down'), c: st('down') }, 'all' as never)).toBe('up')
    expect(status({ a: st('down'), b: st('down'), c: st('down') }, 'all' as never)).toBe('down')
  })

  it('is PENDING while failures are not confirmed yet', () => {
    expect(status({ a: st('up'), b: st('down'), c: st('pending') })).toBe('pending')
    expect(status({ a: st('up'), b: st('pending'), c: st('pending') })).toBe('pending')
  })

  it('waits for a success before announcing UP', () => {
    expect(status({ a: st('down') })).toBe('pending')
    expect(status({ a: st('up') })).toBe('up')
  })

  it('is DEGRADED when degraded and failing locations reach the quorum', () => {
    expect(status({ a: st('up'), b: st('degraded'), c: st('degraded') })).toBe('degraded')
    expect(status({ a: st('up'), b: st('degraded'), c: st('down') })).toBe('degraded')
    expect(status({ a: st('up'), b: st('up'), c: st('degraded') })).toBe('up')
  })

  it('follows maintenance of the reporting location, and of every location for the job', () => {
    expect(status({ a: st('maintenance'), b: st('up'), c: st('up') }, 'half', 'maintenance')).toBe(
      'maintenance',
    )
    expect(status({ a: st('maintenance'), b: st('maintenance') })).toBe('maintenance')
    // Maintenance over: the first location back decides alone until the others report.
    expect(status({ a: st('up'), b: st('maintenance'), c: st('maintenance') }, 'half', 'up')).toBe(
      'up',
    )
  })

  it('reduces to the location status with a single location', () => {
    for (const s of ['up', 'down', 'degraded', 'pending'] as BeatStatus[]) {
      expect(quorumStatus(tallyLocations(['a'], states({ a: st(s) }), 'half'), s)).toBe(s)
    }
  })
})

describe('computeQuorumBeat', () => {
  const settings = { resendInterval: 0 }

  it('announces UP → DOWN and DOWN → UP only', () => {
    const down = computeQuorumBeat({ status: 'up', settledStatus: 'up' }, 'down', settings, 3)
    expect(down).toMatchObject({ important: true, notificationEvent: 'down' })
    const still = computeQuorumBeat({ status: 'down', settledStatus: 'down' }, 'down', settings, 3)
    expect(still).toMatchObject({ important: false, notify: false })
    const up = computeQuorumBeat({ status: 'down', settledStatus: 'down' }, 'up', settings, 3)
    expect(up).toMatchObject({ important: true, notificationEvent: 'up' })
  })

  it('judges a PENDING monitor that was DOWN as DOWN', () => {
    const pending = computeQuorumBeat(
      { status: 'down', settledStatus: 'down' },
      'pending',
      settings,
      3,
    )
    expect(pending).toMatchObject({ important: false, settledStatus: 'down' })
    const recovered = computeQuorumBeat(
      { status: 'pending', settledStatus: 'down' },
      'up',
      settings,
      3,
    )
    expect(recovered).toMatchObject({ important: true, notificationEvent: 'up' })
    const again = computeQuorumBeat(
      { status: 'pending', settledStatus: 'down' },
      'down',
      settings,
      3,
    )
    expect(again).toMatchObject({ important: false, notify: false })
  })

  it('announces UP → PENDING → DOWN once', () => {
    const pending = computeQuorumBeat({ status: 'up', settledStatus: 'up' }, 'pending', settings, 3)
    expect(pending).toMatchObject({ important: false, notify: false, settledStatus: 'up' })
    const down = computeQuorumBeat({ status: 'pending', settledStatus: 'up' }, 'down', settings, 3)
    expect(down).toMatchObject({ important: true, notificationEvent: 'down' })
  })

  it('scales the reminder interval by the number of locations', () => {
    let prev = { status: 'down' as BeatStatus, settledStatus: 'down' as BeatStatus, downCount: 0 }
    const events: (string | null)[] = []
    for (let i = 0; i < 6; i++) {
      const beat = computeQuorumBeat(prev, 'down', { resendInterval: 2 }, 3)
      events.push(beat.notificationEvent)
      prev = { ...prev, downCount: beat.downCount }
    }
    expect(events).toEqual([null, null, null, null, null, 'reminder'])
  })
})

describe('quorumMessage', () => {
  it('names the failing locations with their messages', () => {
    const s = states({ a: st('up'), b: st('down', { lastMsg: 'timeout' }), c: st('down') })
    const tally = tallyLocations(KEYS, s, 'half')
    const names = new Map([
      ['a', 'Berlin'],
      ['b', 'Paris'],
      ['c', 'local'],
    ])
    expect(quorumMessage('down', tally, names, s)).toBe(
      'Down at 2 of 3 locations: Paris (timeout), local',
    )
    const up = quorumMessage(
      'up',
      tallyLocations(KEYS, states({ a: st('up'), b: st('up'), c: st('down') }), 'half'),
      names,
      s,
    )
    expect(up).toBe('Up at 2 of 3 locations; failing: local')
  })
})

describe('per-location retries under the quorum', () => {
  it('turns three locations, two failing with retries, into PENDING then DOWN', () => {
    const monitor = { interval: 60, maxRetries: 1 }
    const locations = new Map<string, LocationState>()
    const retries = new Map<string, number>()
    const beat = (key: string, ok: boolean) => {
      const prev = locations.get(key)
      const next = computeNextBeat(
        { status: prev?.lastStatus, recoveries: prev?.recoveries, retries: retries.get(key) },
        ok ? { ok: true, msg: 'OK' } : { ok: false, msg: 'boom' },
        monitor,
      )
      locations.set(key, { lastStatus: next.status, recoveries: next.recoveries })
      retries.set(key, next.retries)
      return quorumStatus(tallyLocations(KEYS, locations, 'half'), next.status)
    }
    expect(beat('a', true)).toBe('up')
    expect(beat('b', false)).toBe('up') // one retrying location of three
    expect(beat('c', true)).toBe('up')
    expect(beat('b', false)).toBe('up') // b is DOWN, c and a still up
    expect(beat('c', false)).toBe('pending')
    expect(beat('c', false)).toBe('down')
  })
})
