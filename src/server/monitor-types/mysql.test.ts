import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLOSED_HOST, CLOSED_PORT, makeMonitor, runCheck } from './test-helpers'
import { describeRows, sqlQueryOf } from './sql'
import './index'

describe('mysql monitor', () => {
  afterEach(() => {
    vi.doUnmock('mysql2/promise')
  })

  it('defaults the query to SELECT 1 and reports row counts', () => {
    expect(sqlQueryOf({ databaseQuery: null })).toBe('SELECT 1')
    expect(sqlQueryOf({ databaseQuery: '  SELECT now()  ' })).toBe('SELECT now()')
    expect(describeRows([{ a: 1 }, { a: 2 }])).toBe('Rows: 2')
    expect(describeRows({ affectedRows: 1 })).toMatch(/not an array/)
  })

  it('requires a connection string', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'mysql', databaseConnectionString: '' })),
    ).rejects.toThrow('Connection string is required')
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'mysql',
      databaseConnectionString: `mysql://root:secret@${CLOSED_HOST}:${CLOSED_PORT}/test`,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Database connection\/query failed: .*ECONNREFUSED/,
    )
  })

  it('explains how to install the driver when mysql2 is missing', async () => {
    vi.doMock('mysql2/promise', () => {
      throw Object.assign(new Error("Cannot find module 'mysql2/promise'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'mysql',
      databaseConnectionString: `mysql://root@${CLOSED_HOST}:${CLOSED_PORT}/test`,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install mysql2 to use the MySQL monitor/)
  })
})
