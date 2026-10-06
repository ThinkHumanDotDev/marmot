/**
 * Microsoft SQL Server monitor: connects with `databaseConnectionString` and runs `databaseQuery`
 * (default `SELECT 1`); UP when the statement succeeds. The `mssql` driver is an optional
 * dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/mssql.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. (Condition evaluation is left to the conditions issue.)
 */
import { registerMonitorType } from './registry'
import { describeRows, sqlQueryOf } from './sql'
import { errorMessage, loadOptionalDriver, requireField, withAbort } from './util'

registerMonitorType({
  name: 'sqlserver',
  label: 'Microsoft SQL Server',
  group: 'database',
  async check(ctx) {
    const connectionString = requireField(ctx.monitor.databaseConnectionString, 'Connection string')
    const query = sqlQueryOf(ctx.monitor)
    const mssql = await loadOptionalDriver(() => import('mssql'), 'mssql', 'SQL Server')

    const startTime = Date.now()
    const pool = new mssql.ConnectionPool(connectionString)
    pool.on('error', () => undefined)
    try {
      await withAbort(pool.connect(), ctx.signal, () => void pool.close().catch(() => undefined))
      const result = await withAbort(pool.request().query(query), ctx.signal)
      ctx.heartbeat.ping = Date.now() - startTime
      ctx.heartbeat.msg = describeRows(result.recordset)
      ctx.heartbeat.status = 'up'
    } catch (err) {
      ctx.heartbeat.ping = Date.now() - startTime
      throw new Error(`Database connection/query failed: ${errorMessage(err)}`)
    } finally {
      await pool.close().catch(() => undefined)
    }
  },
})
