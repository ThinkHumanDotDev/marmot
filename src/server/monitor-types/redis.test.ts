import { describe, expect, it } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import './index'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

describe('redis monitor', () => {
  it('requires a redis:// connection string', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'redis', databaseConnectionString: null })),
    ).rejects.toThrow('Connection string is required')
    await expect(
      runCheck(makeMonitor({ type: 'redis', databaseConnectionString: 'localhost:6379' })),
    ).rejects.toThrow(/redis:\/\/ or rediss:\/\//)
  })

  it('is UP with PONG against the local Redis', async () => {
    const beat = await runCheck(makeMonitor({ type: 'redis', databaseConnectionString: REDIS_URL }))
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('PONG')
    expect(beat.ping).toBeGreaterThanOrEqual(0)
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'redis',
      databaseConnectionString: `redis://${CLOSED_HOST}:${CLOSED_PORT}`,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Redis connection failed: .*ECONNREFUSED/)
  })
})
