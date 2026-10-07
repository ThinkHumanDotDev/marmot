/**
 * SNMP monitor: GETs `snmpOid` from `hostname:port` (default 161) with `snmpCommunity` over
 * SNMPv1/v2c. Without an expected value the monitor is UP whenever the OID answers; with one, the
 * value (optionally transformed by `jsonPath`) is compared using `jsonPathOperator`.
 * `net-snmp` is an optional dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/snmp.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. (SNMPv3 is not supported yet.)
 */
import type { Varbind } from 'net-snmp'

import type { Monitor } from '@/payload-types'

import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { evaluateJsonQuery } from './json-query'
import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  loadOptionalDriver,
  requireField,
  requireHostname,
  responseExcerpt,
  withAbort,
} from './util'

export const DEFAULT_SNMP_PORT = 161
export const DEFAULT_SNMP_COMMUNITY = 'public'

/** GET one OID and resolve with its value as a string. */
export async function snmpGet(
  monitor: Pick<Monitor, 'hostname' | 'port' | 'snmpOid' | 'snmpVersion' | 'snmpCommunity'>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const hostname = requireHostname(monitor)
  const oid = requireField(monitor.snmpOid, 'OID')
  const snmp = await loadOptionalDriver(() => import('net-snmp'), 'net-snmp', 'SNMP')
  // Outbound address guard: the session talks to the vetted address (null when the guard is off).
  const vetted = await resolveGuardedTarget(hostname)

  const session = snmp.createSession(
    vetted?.address ?? hostname,
    monitor.snmpCommunity || DEFAULT_SNMP_COMMUNITY,
    {
      port: monitor.port || DEFAULT_SNMP_PORT,
      retries: 0,
      timeout: timeoutMs,
      version: monitor.snmpVersion === '1' ? snmp.Version1 : snmp.Version2c,
    },
  )

  try {
    const varbinds = await withAbort(
      new Promise<Varbind[]>((resolve, reject) => {
        session.on('error', (error: Error) =>
          reject(new Error(`Error creating SNMP session: ${error.message}`)),
        )
        session.get([oid], (error, result) => (error ? reject(error) : resolve(result ?? [])))
      }),
      signal,
      () => session.close(),
    )

    if (!varbinds || varbinds.length === 0) {
      throw new Error(`No varbinds returned from SNMP session (OID: ${oid})`)
    }
    const varbind = varbinds[0]
    if (snmp.isVarbindError(varbind)) {
      throw new Error(snmp.varbindError(varbind))
    }
    if (varbind.type === snmp.ObjectType.NoSuchInstance) {
      throw new Error(`The SNMP query returned that no instance exists for OID ${oid}`)
    }
    const value = varbind.value
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
  } finally {
    session.close()
  }
}

registerMonitorType({
  name: 'snmp',
  label: 'SNMP',
  group: 'specific',
  async check(ctx) {
    const startTime = Date.now()
    const value = await snmpGet(ctx.monitor, checkTimeoutMs(ctx.monitor), ctx.signal)
    ctx.heartbeat.ping = Date.now() - startTime

    const { jsonPath, expectedValue } = ctx.monitor
    const operator = ctx.monitor.jsonPathOperator ?? '=='
    if (expectedValue === null || expectedValue === undefined || expectedValue === '') {
      ctx.heartbeat.msg = `${ctx.monitor.snmpOid} = ${responseExcerpt(value)}`
      ctx.heartbeat.status = 'up'
      return
    }

    const { status, response } = await evaluateJsonQuery(value, jsonPath, operator, expectedValue)
    if (!status) {
      throw new Error(
        `JSON query does not pass (comparing ${responseExcerpt(response)} ${operator} ${expectedValue})`,
      )
    }
    ctx.heartbeat.msg = `JSON query passes (comparing ${responseExcerpt(response)} ${operator} ${expectedValue})`
    ctx.heartbeat.status = 'up'
  },
})
