/**
 * MongoDB monitor: connects with `databaseConnectionString` and runs the command in
 * `databaseQuery` (JSON, default `{"ping": 1}`). Optionally evaluates `jsonPath` (JSONata) over
 * the result and compares it with `expectedValue`. The `mongodb` driver is an optional dependency
 * loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/mongodb.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import jsonata from 'jsonata'

import { assertConnectionTargetsAllowed } from '@/server/security/connection-hosts'
import { guardedLookup, outboundGuardActive } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  errorMessage,
  loadOptionalDriver,
  parseJsonObject,
  requireField,
  responseExcerpt,
  withAbort,
} from './util'

registerMonitorType({
  name: 'mongodb',
  label: 'MongoDB',
  group: 'database',
  async check(ctx) {
    const connectionString = requireField(ctx.monitor.databaseConnectionString, 'Connection string')
    const command = ctx.monitor.databaseQuery?.trim()
      ? parseJsonObject(ctx.monitor.databaseQuery, 'Command')
      : { ping: 1 }
    const { MongoClient } = await loadOptionalDriver(() => import('mongodb'), 'mongodb', 'MongoDB')
    const timeout = checkTimeoutMs(ctx.monitor)

    // Outbound address guard: the seed list, SRV targets and SOCKS proxy host are pre-checked,
    // and every connection to a named host resolves through `guardedLookup` at connect time.
    // Residual: replica-set members advertised by the server as IP literals are connected without
    // a lookup (Node skips it for literals), so they are not vetted.
    await assertConnectionTargetsAllowed(connectionString)
    const client = new MongoClient(connectionString, {
      serverSelectionTimeoutMS: timeout,
      connectTimeoutMS: timeout,
      socketTimeoutMS: timeout,
      ...(outboundGuardActive() ? { lookup: guardedLookup as never } : {}),
    })
    const startTime = Date.now()
    let result: unknown
    try {
      await withAbort(
        client.connect(),
        ctx.signal,
        () => void client.close().catch(() => undefined),
      )
      result = await withAbort(client.db().command(command), ctx.signal)
    } catch (err) {
      throw new Error(`MongoDB connection/command failed: ${errorMessage(err)}`)
    } finally {
      await client.close().catch(() => undefined)
    }
    ctx.heartbeat.ping = Date.now() - startTime

    if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== 1) {
      throw new Error('MongoDB command failed')
    }
    ctx.heartbeat.msg = 'Command executed successfully'

    if (ctx.monitor.jsonPath) {
      result = await jsonata(ctx.monitor.jsonPath).evaluate(result)
      if (!result) {
        throw new Error('Queried value not found.')
      }
      ctx.heartbeat.msg =
        'Command executed successfully and the jsonata expression produces a result.'
    }

    if (ctx.monitor.expectedValue) {
      if (String(result) === ctx.monitor.expectedValue) {
        ctx.heartbeat.msg = 'Command executed successfully and expected value was found'
      } else {
        throw new Error(
          `Query executed, but value is not equal to expected value, value was: [${responseExcerpt(JSON.stringify(result))}]`,
        )
      }
    }

    ctx.heartbeat.status = 'up'
  },
})
