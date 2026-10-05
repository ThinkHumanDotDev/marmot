import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import './index'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const hasPostgres = /^postgres(ql)?:\/\//.test(DATABASE_URL)

describe('postgres monitor', () => {
  afterEach(() => {
    vi.doUnmock('pg')
  })

  it('requires a connection string', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'postgres', databaseConnectionString: null })),
    ).rejects.toThrow('Connection string is required')
  })

  it.skipIf(!hasPostgres)('is UP when SELECT 1 succeeds against the test database', async () => {
    const beat = await runCheck(
      makeMonitor({ type: 'postgres', databaseConnectionString: DATABASE_URL, timeout: 10 }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('Rows: 1')
    expect(beat.ping).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(!hasPostgres)('fails when the query errors', async () => {
    const monitor = makeMonitor({
      type: 'postgres',
      databaseConnectionString: DATABASE_URL,
      databaseQuery: 'SELECT * FROM table_that_does_not_exist_42',
      timeout: 10,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Database connection\/query failed: .*does not exist/,
    )
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'postgres',
      databaseConnectionString: `postgres://marmot:marmot@${CLOSED_HOST}:${CLOSED_PORT}/marmot`,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Database connection\/query failed: .*ECONNREFUSED/,
    )
  })

  it('explains how to install the driver when pg is missing', async () => {
    vi.doMock('pg', () => {
      throw Object.assign(new Error("Cannot find package 'pg'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const monitor = makeMonitor({
      type: 'postgres',
      databaseConnectionString: `postgres://marmot@${CLOSED_HOST}:${CLOSED_PORT}/marmot`,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install pg to use the PostgreSQL monitor/)
  })
})
