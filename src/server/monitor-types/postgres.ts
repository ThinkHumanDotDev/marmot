/**
 * PostgreSQL monitor: connects with `databaseConnectionString` and runs `databaseQuery`
 * (default `SELECT 1`); UP when the statement succeeds. The `pg` driver is an optional dependency
 * loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/postgres.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import net from 'node:net'

import { guardNetSocket, outboundGuardActive } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { describeRows, sqlQueryOf } from './sql'
import { checkTimeoutMs, errorMessage, loadOptionalDriver, requireField, withAbort } from './util'

registerMonitorType({
  name: 'postgres',
  label: 'PostgreSQL',
  group: 'database',
  async check(ctx) {
    const connectionString = requireField(ctx.monitor.databaseConnectionString, 'Connection string')
    const query = sqlQueryOf(ctx.monitor)
    const { Client } = await loadOptionalDriver(() => import('pg'), 'pg', 'PostgreSQL')
    const timeout = checkTimeoutMs(ctx.monitor)

    const client = new Client({
      connectionString,
      connectionTimeoutMillis: timeout,
      query_timeout: timeout,
      statement_timeout: timeout,
      // Outbound address guard: pg calls `connect(port, host)` on this socket for every host it
      // tries, so each one is resolved, vetted and connected to by address (unix sockets refused).
      ...(outboundGuardActive() ? { stream: () => guardNetSocket(new net.Socket()) } : {}),
    })
    // `pg` emits connection errors as events as well; without a listener they would crash the worker.
    client.on('error', () => undefined)

    const startTime = Date.now()
    try {
      await withAbort(client.connect(), ctx.signal, () => void client.end().catch(() => undefined))
      const result = await withAbort(client.query(query), ctx.signal)
      ctx.heartbeat.ping = Date.now() - startTime
      ctx.heartbeat.msg = describeRows(result.rows)
      ctx.heartbeat.status = 'up'
    } catch (err) {
      ctx.heartbeat.ping = Date.now() - startTime
      throw new Error(`Database connection/query failed: ${errorMessage(err)}`)
    } finally {
      await client.end().catch(() => undefined)
    }
  },
})
