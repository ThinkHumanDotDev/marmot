/**
 * Redis monitor: connects with `databaseConnectionString` (`redis://` or `rediss://`) and sends
 * PING; UP when the server answers. Uses `ioredis`, which Marmot already ships for BullMQ, so no
 * optional driver is needed.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/redis.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import { Redis } from 'ioredis'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, errorMessage, requireField, withAbort } from './util'

/** PING a Redis server once and resolve with its reply (`PONG`). */
export async function redisPing(
  url: string,
  options: { timeoutMs: number; rejectUnauthorized?: boolean; signal?: AbortSignal },
): Promise<string> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: options.timeoutMs,
    commandTimeout: options.timeoutMs,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    ...(url.startsWith('rediss://')
      ? { tls: { rejectUnauthorized: options.rejectUnauthorized ?? true } }
      : {}),
  })
  // ioredis reports the socket error (ECONNREFUSED, …) on the event and rejects `connect()` with a
  // generic "Connection is closed."; keep the specific one for the heartbeat message.
  let lastError: Error | undefined
  client.on('error', (err) => {
    lastError = err
  })
  try {
    await withAbort(client.connect(), options.signal, () => client.disconnect())
    return await withAbort(client.ping(), options.signal, () => client.disconnect())
  } catch (err) {
    throw lastError ?? err
  } finally {
    client.disconnect()
  }
}

registerMonitorType({
  name: 'redis',
  label: 'Redis',
  group: 'database',
  async check(ctx) {
    const url = requireField(ctx.monitor.databaseConnectionString, 'Connection string')
    if (!/^rediss?:\/\//i.test(url)) {
      throw new Error('Connection string must start with redis:// or rediss://')
    }
    const startTime = Date.now()
    try {
      ctx.heartbeat.msg = await redisPing(url, {
        timeoutMs: checkTimeoutMs(ctx.monitor),
        rejectUnauthorized: !ctx.monitor.ignoreTls,
        signal: ctx.signal,
      })
    } catch (err) {
      throw new Error(`Redis connection failed: ${errorMessage(err)}`)
    }
    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.status = 'up'
  },
})
