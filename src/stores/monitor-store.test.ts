import { beforeEach, describe, expect, it } from 'vitest'

import {
  HEARTBEAT_BUFFER_SIZE,
  HeartbeatStatus,
  selectHeartbeats,
  selectLatestHeartbeat,
  selectMonitorList,
  selectMonitorStatus,
  selectStatusCounts,
  selectUptime,
  useMonitorStore,
  type Heartbeat,
  type MonitorSummary,
} from './monitor-store'

const monitor = (id: string, name: string, active = true): MonitorSummary => ({
  id,
  name,
  type: 'http',
  active,
  interval: 60,
})

const beat = (
  monitorId: string,
  status: Heartbeat['status'],
  extra: Partial<Heartbeat> = {},
): Heartbeat => ({
  monitor: monitorId,
  status,
  time: new Date().toISOString(),
  ping: 42,
  ...extra,
})

describe('useMonitorStore', () => {
  beforeEach(() => {
    useMonitorStore.getState().reset()
  })

  it('stores monitors by id and exposes a sorted list', () => {
    const { setMonitors } = useMonitorStore.getState()
    setMonitors([monitor('2', 'Zeta'), monitor(1 as unknown as string, 'Alpha')])
    const state = useMonitorStore.getState()
    expect(state.hydrated).toBe(true)
    expect(Object.keys(state.monitors)).toEqual(['1', '2'])
    expect(selectMonitorList(state).map((m) => m.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('keeps a bounded heartbeat ring buffer per monitor', () => {
    const { setMonitors, pushHeartbeat } = useMonitorStore.getState()
    setMonitors([monitor('1', 'API')])
    for (let i = 0; i < HEARTBEAT_BUFFER_SIZE + 5; i++) {
      pushHeartbeat(beat('1', HeartbeatStatus.UP, { ping: i }))
    }
    const beats = selectHeartbeats('1')(useMonitorStore.getState())
    expect(beats.size).toBe(HEARTBEAT_BUFFER_SIZE)
    expect(beats.first()?.ping).toBe(5)
    expect(selectLatestHeartbeat(1)(useMonitorStore.getState())?.ping).toBe(
      HEARTBEAT_BUFFER_SIZE + 4,
    )
  })

  it('tracks important heartbeats separately', () => {
    const { pushHeartbeat } = useMonitorStore.getState()
    pushHeartbeat(beat('1', HeartbeatStatus.UP))
    pushHeartbeat(beat('1', HeartbeatStatus.DOWN, { important: true }))
    const state = useMonitorStore.getState()
    expect(state.heartbeats['1'].size).toBe(2)
    expect(state.importantHeartbeats['1'].size).toBe(1)
    expect(state.importantHeartbeats['1'].last()?.status).toBe(HeartbeatStatus.DOWN)
  })

  it('replaces history with setHeartbeatList', () => {
    const { pushHeartbeat, setHeartbeatList } = useMonitorStore.getState()
    pushHeartbeat(beat('1', HeartbeatStatus.UP))
    setHeartbeatList('1', [beat('1', HeartbeatStatus.DOWN), beat('1', HeartbeatStatus.PENDING)])
    expect(
      selectHeartbeats('1')(useMonitorStore.getState())
        .toArray()
        .map((b) => b.status),
    ).toEqual([HeartbeatStatus.DOWN, HeartbeatStatus.PENDING])
  })

  it('derives status and counts from the newest heartbeat', () => {
    const { setMonitors, pushHeartbeat } = useMonitorStore.getState()
    setMonitors([
      monitor('1', 'Up'),
      monitor('2', 'Down'),
      monitor('3', 'Paused', false),
      monitor('4', 'Fresh'),
    ])
    pushHeartbeat(beat('1', HeartbeatStatus.UP))
    pushHeartbeat(beat('2', HeartbeatStatus.UP))
    pushHeartbeat(beat('2', HeartbeatStatus.DOWN))
    pushHeartbeat(beat('3', HeartbeatStatus.UP))
    const state = useMonitorStore.getState()
    expect(selectMonitorStatus('1')(state)).toBe('up')
    expect(selectMonitorStatus('2')(state)).toBe('down')
    expect(selectMonitorStatus('3')(state)).toBe('unknown')
    expect(selectStatusCounts(state)).toEqual({
      up: 1,
      down: 1,
      pending: 0,
      maintenance: 0,
      unknown: 2,
    })
  })

  it('stores uptime per period and average ping', () => {
    const { setUptime, setAvgPing } = useMonitorStore.getState()
    setUptime('1', '24h', 99.5)
    setUptime('1', '30d', 98)
    setAvgPing('1', 120)
    const state = useMonitorStore.getState()
    expect(selectUptime('1', '24h')(state)).toBe(99.5)
    expect(selectUptime('1', '30d')(state)).toBe(98)
    expect(selectUptime('1', '1y')(state)).toBeUndefined()
    expect(state.avgPing['1']).toBe(120)
  })

  it('removes every trace of a monitor', () => {
    const { setMonitors, pushHeartbeat, setUptime, removeMonitor } = useMonitorStore.getState()
    setMonitors([monitor('1', 'A'), monitor('2', 'B')])
    pushHeartbeat(beat('1', HeartbeatStatus.UP))
    setUptime('1', '24h', 100)
    removeMonitor('1')
    const state = useMonitorStore.getState()
    expect(state.monitors['1']).toBeUndefined()
    expect(state.heartbeats['1']).toBeUndefined()
    expect(state.uptime['1']).toBeUndefined()
    expect(state.monitors['2']).toBeDefined()
  })
})
