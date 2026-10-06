/**
 * Microsoft SQL Server monitor: connects with `databaseConnectionString` and runs `databaseQuery`
 * (default `SELECT 1`); UP when the statement succeeds. The `mssql` driver is an optional
 * dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/mssql.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. (Condition evaluation is left to the conditions issue.)
 */
import net from 'node:net'

import { outboundGuardActive, resolveGuardedTarget } from '@/server/security/outbound-guard'
import { assertConnectionTargetsAllowed } from '@/server/security/connection-hosts'

import { registerMonitorType } from './registry'
import { describeRows, sqlQueryOf } from './sql'
import { errorMessage, loadOptionalDriver, requireField, withAbort } from './util'

/**
 * tedious connector that passes the outbound address guard: every connection (Azure redirects
 * included) resolves the host, vets every address and connects to the vetted one.
 */
export async function guardedTediousConnector(
  options: { host: string; port: number; localAddress?: string },
  _lookup: unknown,
  signal: AbortSignal,
): Promise<net.Socket> {
  const vetted = await resolveGuardedTarget(options.host)
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({
      host: vetted?.address ?? options.host,
      port: options.port,
      localAddress: options.localAddress,
      signal,
    })
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

registerMonitorType({
  name: 'sqlserver',
  label: 'Microsoft SQL Server',
  group: 'database',
  async check(ctx) {
    const connectionString = requireField(ctx.monitor.databaseConnectionString, 'Connection string')
    const query = sqlQueryOf(ctx.monitor)
    const mssql = await loadOptionalDriver(() => import('mssql'), 'mssql', 'SQL Server')

    let poolConfig: string | import('mssql').config = connectionString
    if (outboundGuardActive()) {
      // Pre-check of the named host(s) for the SQL Server Browser lookup of named instances (UDP,
      // made by tedious itself: a small time-of-check/time-of-use window remains there); the TDS
      // connection itself goes through `guardedTediousConnector` at connect time.
      await assertConnectionTargetsAllowed(connectionString)
      const parsed = mssql.ConnectionPool.parseConnectionString(connectionString)
      poolConfig = {
        ...parsed,
        options: { ...parsed.options, connector: guardedTediousConnector } as never,
      }
    }

    const startTime = Date.now()
    const pool = new mssql.ConnectionPool(poolConfig as import('mssql').config)
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
