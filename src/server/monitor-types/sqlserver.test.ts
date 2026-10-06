import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLOSED_HOST, CLOSED_PORT, makeMonitor, runCheck } from './test-helpers'
import './index'

describe('sqlserver monitor', () => {
  afterEach(() => {
    vi.doUnmock('mssql')
  })

  it('requires a connection string', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'sqlserver', databaseConnectionString: null })),
    ).rejects.toThrow('Connection string is required')
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'sqlserver',
      databaseConnectionString: `Server=${CLOSED_HOST},${CLOSED_PORT};Database=test;User Id=sa;Password=secret;Encrypt=false;Connection Timeout=2`,
      timeout: 3,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Database connection\/query failed: .+/)
  })

  it('explains how to install the driver when mssql is missing', async () => {
    vi.doMock('mssql', () => {
      throw Object.assign(new Error("Cannot find package 'mssql'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'sqlserver',
      databaseConnectionString: `Server=${CLOSED_HOST},${CLOSED_PORT};Database=test`,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install mssql to use the SQL Server monitor/)
  })
})
