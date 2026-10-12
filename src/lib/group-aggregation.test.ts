import { describe, expect, it } from 'vitest'

import {
  aggregateGroup,
  groupLatency,
  requiredUp,
  weightedScore,
  type ChildStatus,
  type GroupChild,
} from './group-aggregation'

const child = (
  name: string,
  status: ChildStatus | null,
  extra: Partial<GroupChild> = {},
): GroupChild => ({ name, status, active: true, ...extra })

/** `api-1` … `api-n`, the listed ones down, the others up. */
const replicas = (n: number, down: number[] = []): GroupChild[] =>
  Array.from({ length: n }, (_, i) => child(`api-${i + 1}`, down.includes(i + 1) ? 'down' : 'up'))

describe('worst (default)', () => {
  it('keeps the behaviour and messages groups had before #144', () => {
    expect(aggregateGroup([])).toEqual({ status: 'pending', msg: 'Group empty', ping: null })
    expect(aggregateGroup(replicas(3))).toMatchObject({
      status: 'up',
      msg: 'All children up and running',
    })
    expect(aggregateGroup([...replicas(2, [2]), child('db', 'pending')])).toMatchObject({
      status: 'down',
      msg: 'Child monitors down: api-2; pending: db',
    })
    expect(aggregateGroup([child('a', 'up'), child('b', null)])).toMatchObject({
      status: 'pending',
      msg: 'Pending child monitors: b',
    })
    expect(aggregateGroup([child('a', 'degraded'), child('b', 'maintenance')])).toMatchObject({
      status: 'degraded',
      msg: 'Degraded child monitors: a',
    })
  })

  it('ignores paused children; all paused is UP', () => {
    expect(aggregateGroup([child('a', 'down', { active: false }), child('b', 'up')]).status).toBe(
      'up',
    )
    expect(aggregateGroup([child('a', 'down', { active: false })]).status).toBe('up')
  })

  it('is the mode when none is set', () => {
    expect(aggregateGroup(replicas(5, [1]), { mode: null }).status).toBe('down')
  })
})

describe('quorum', () => {
  const settings = { mode: 'quorum', quorum: 3, quorumUnit: 'count' } as const

  it('a group of 5 with min 3 stays up (degraded) with 2 down and goes DOWN with 3 down', () => {
    expect(aggregateGroup(replicas(5), settings)).toMatchObject({ status: 'up' })
    const two = aggregateGroup(replicas(5, [3, 5]), settings)
    expect(two.status).toBe('degraded')
    expect(two.msg).toBe('3/5 children up (quorum 3); 2/5 children down: api-3, api-5')
    const three = aggregateGroup(replicas(5, [1, 3, 5]), settings)
    expect(three.status).toBe('down')
    expect(three.msg).toBe('2/5 children up (quorum 3); 3/5 children down: api-1, api-3, api-5')
  })

  it('counts degraded and maintenance children as serving', () => {
    const children = [
      child('a', 'degraded'),
      child('b', 'maintenance'),
      child('c', 'down'),
      child('d', 'down'),
    ]
    expect(aggregateGroup(children, { mode: 'quorum', quorum: 2 }).status).toBe('degraded')
    expect(aggregateGroup(children.slice(0, 2), { mode: 'quorum', quorum: 2 }).status).toBe(
      'degraded',
    )
    expect(aggregateGroup(children.slice(1, 2), { mode: 'quorum', quorum: 1 }).status).toBe('up')
  })

  it('is PENDING while retrying children could still make the quorum', () => {
    const children = [child('a', 'up'), child('b', 'pending'), child('c', 'down')]
    expect(aggregateGroup(children, { mode: 'quorum', quorum: 2 }).status).toBe('pending')
    expect(aggregateGroup(children, { mode: 'quorum', quorum: 3 }).status).toBe('down')
  })

  it('supports a percentage of the active children', () => {
    expect(requiredUp(5, 50, 'percent')).toBe(3)
    expect(requiredUp(4, 50, 'percent')).toBe(2)
    expect(requiredUp(3, 100, 'percent')).toBe(3)
    expect(requiredUp(5, 0, 'percent')).toBe(1)
    expect(requiredUp(3, 10, 'count')).toBe(3)
    expect(requiredUp(3, null, null)).toBe(1)
    const percent = { mode: 'quorum', quorum: 60, quorumUnit: 'percent' } as const
    expect(aggregateGroup(replicas(5, [1, 2]), percent).status).toBe('degraded')
    expect(aggregateGroup(replicas(5, [1, 2, 3]), percent).status).toBe('down')
    // Paused children are not counted.
    const paused = [...replicas(2, [2]), child('off', 'down', { active: false })]
    expect(aggregateGroup(paused, percent).status).toBe('down')
    expect(aggregateGroup(paused, { ...percent, quorum: 50 }).status).toBe('degraded')
  })
})

describe('weighted', () => {
  it('scores up = 1, degraded = 0.5 and down = 0 with normalised weights', () => {
    expect(weightedScore([child('a', 'up'), child('b', 'down')])).toBe(0.5)
    expect(
      weightedScore([child('a', 'up', { weight: 3 }), child('b', 'down', { weight: 1 })]),
    ).toBe(0.75)
    expect(
      weightedScore([child('a', 'degraded', { weight: 0.5 }), child('b', 'up', { weight: 0.5 })]),
    ).toBe(0.75)
    expect(
      weightedScore([
        child('a', 'up', { weight: 0.1 }),
        child('b', 'up', { weight: 0.2 }),
        child('c', 'maintenance', { weight: 0.7 }),
      ]),
    ).toBe(1)
  })

  it('treats zero weights as no say, and all-zero weights as equal', () => {
    expect(
      weightedScore([child('a', 'up', { weight: 1 }), child('b', 'down', { weight: 0 })]),
    ).toBe(1)
    expect(
      weightedScore([child('a', 'up', { weight: 0 }), child('b', 'down', { weight: 0 })]),
    ).toBe(0.5)
  })

  it('leaves paused and pending children out of the score', () => {
    expect(
      weightedScore([
        child('a', 'up'),
        child('b', 'down', { active: false }),
        child('c', 'pending'),
        child('d', null),
      ]),
    ).toBe(1)
    expect(weightedScore([child('a', 'pending'), child('b', null)])).toBeNull()
  })

  it('maps a score of 1 to UP, 0 to DOWN and anything between to DEGRADED', () => {
    const mode = { mode: 'weighted' } as const
    expect(aggregateGroup(replicas(2), mode)).toMatchObject({ status: 'up', score: 1 })
    expect(aggregateGroup(replicas(2, [1, 2]), mode)).toMatchObject({
      status: 'down',
      score: 0,
      msg: 'Score 0%; 2/2 children down: api-1, api-2',
    })
    expect(aggregateGroup(replicas(4, [4]), mode)).toMatchObject({
      status: 'degraded',
      score: 0.75,
      msg: 'Score 75%; 1/4 children down: api-4',
    })
    expect(aggregateGroup([child('a', 'pending')], mode).status).toBe('pending')
    // A down child without weight cannot pull the group down.
    expect(
      aggregateGroup([child('a', 'up'), child('b', 'down', { weight: 0 })], mode),
    ).toMatchObject({ status: 'up', msg: 'Score 100%; 1/2 children down: b' })
  })
})

describe('latency', () => {
  const children = [
    child('a', 'up', { ping: 100 }),
    child('b', 'up', { ping: 301 }),
    child('c', 'up', { ping: null }),
    child('d', 'up', { ping: 5, active: false }),
  ]

  it('is the average, maximum or minimum ping of the active children', () => {
    expect(groupLatency(children, 'avg')).toBe(201)
    expect(groupLatency(children, 'max')).toBe(301)
    expect(groupLatency(children, 'min')).toBe(100)
    expect(groupLatency(children, 'none')).toBeNull()
    expect(groupLatency(children, null)).toBeNull()
    expect(groupLatency([child('a', 'up')], 'avg')).toBeNull()
    expect(aggregateGroup(children, { latency: 'max' }).ping).toBe(301)
  })
})
