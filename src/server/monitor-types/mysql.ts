/**
 * MySQL / MariaDB monitor: connects with `databaseConnectionString` and runs `databaseQuery`
 * (default `SELECT 1`); UP when the statement succeeds. The `mysql2` driver is an optional
 * dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/mysql.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. (Condition evaluation is left to the conditions issue.)
 */
import { guardedNetConnect, outboundGuardActive } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { describeRows, sqlQueryOf } from './sql'
import { checkTimeoutMs, errorMessage, loadOptionalDriver, requireField, withAbort } from './util'

registerMonitorType({
  name: 'mysql',
  label: 'MySQL/MariaDB',
  group: 'database',
  async check(ctx) {
    const uri = requireField(ctx.monitor.databaseConnectionString, 'Connection string')
    const query = sqlQueryOf(ctx.monitor)
    const mysql = await loadOptionalDriver(() => import('mysql2/promise'), 'mysql2', 'MySQL')
    const timeout = checkTimeoutMs(ctx.monitor)

    const startTime = Date.now()
    let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined
    try {
      connection = await withAbort(
        mysql.createConnection({
          uri,
          connectTimeout: timeout,
          // Outbound address guard: open the socket ourselves through the guard (vetted at
          // connect time; unix sockets refused). TLS upgrades keep verifying the configured name.
          ...(outboundGuardActive()
            ? {
                stream: (opts: { config: { host?: string; port?: number; socketPath?: string } }) =>
                  guardedNetConnect({
                    host: opts.config.host,
                    port: opts.config.port,
                    path: opts.config.socketPath,
                  }),
              }
            : {}),
        }),
        ctx.signal,
      )
      const conn = connection
      const [rows] = await withAbort(conn.query({ sql: query, timeout }), ctx.signal, () =>
        conn.destroy(),
      )
      ctx.heartbeat.ping = Date.now() - startTime
      ctx.heartbeat.msg = describeRows(rows)
      ctx.heartbeat.status = 'up'
    } catch (err) {
      ctx.heartbeat.ping = Date.now() - startTime
      throw new Error(`Database connection/query failed: ${errorMessage(err)}`)
    } finally {
      if (connection) {
        const conn = connection
        await conn.end().catch(() => conn.destroy())
      }
    }
  },
})
