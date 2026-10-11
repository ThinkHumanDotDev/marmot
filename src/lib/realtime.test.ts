import { describe, expect, it } from 'vitest'

import { HeartbeatStatus } from '@/stores/monitor-store'
import {
  heartbeatStatusName,
  parseHeartbeatStatus,
  toStoreHeartbeat,
  toStoreMonitor,
} from './realtime'

describe('realtime status mapping', () => {
  it('maps server status strings to the store enum', () => {
    expect(parseHeartbeatStatus('up')).toBe(HeartbeatStatus.UP)
    expect(parseHeartbeatStatus('down')).toBe(HeartbeatStatus.DOWN)
    expect(parseHeartbeatStatus('pending')).toBe(HeartbeatStatus.PENDING)
    expect(parseHeartbeatStatus('maintenance')).toBe(HeartbeatStatus.MAINTENANCE)
    expect(parseHeartbeatStatus('degraded')).toBe(HeartbeatStatus.DEGRADED)
    expect(parseHeartbeatStatus('UP')).toBe(HeartbeatStatus.UP)
  })

  it('treats unknown or missing values as pending', () => {
    expect(parseHeartbeatStatus('weird')).toBe(HeartbeatStatus.PENDING)
    expect(parseHeartbeatStatus(undefined)).toBe(HeartbeatStatus.PENDING)
    expect(parseHeartbeatStatus(null)).toBe(HeartbeatStatus.PENDING)
  })

  it('round-trips every enum value through its name', () => {
    for (const status of Object.values(HeartbeatStatus)) {
      expect(parseHeartbeatStatus(heartbeatStatusName(status))).toBe(status)
    }
  })

  it('converts wire heartbeats and monitors to store shapes with string ids', () => {
    const beat = toStoreHeartbeat({
      monitor: '12',
      status: 'down',
      time: '2026-10-05T10:00:00.000Z',
      ping: null,
      msg: 'timeout',
      important: true,
    })
    expect(beat).toEqual({
      monitor: '12',
      status: HeartbeatStatus.DOWN,
      time: '2026-10-05T10:00:00.000Z',
      ping: null,
      msg: 'timeout',
      important: true,
      duration: null,
    })

    const monitor = toStoreMonitor({
      id: '7',
      name: 'API',
      type: 'http',
      active: true,
      interval: 60,
      url: 'https://example.com',
      organization: '3',
    })
    expect(monitor).toEqual({
      id: '7',
      name: 'API',
      type: 'http',
      active: true,
      interval: 60,
      url: 'https://example.com',
      hostname: null,
      organization: '3',
      tags: [],
      description: null,
      notifications: [],
      locations: [],
      includeLocal: false,
    })

    // The list's filter fields (#124) travel as string ids.
    expect(
      toStoreMonitor({
        id: '8',
        name: 'Web',
        type: 'http',
        active: true,
        interval: 60,
        description: 'Shop',
        notifications: ['4'],
        locations: ['9'],
        includeLocal: true,
      }),
    ).toMatchObject({
      description: 'Shop',
      notifications: ['4'],
      locations: ['9'],
      includeLocal: true,
    })
  })
})
