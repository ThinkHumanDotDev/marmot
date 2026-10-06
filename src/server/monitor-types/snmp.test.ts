import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLOSED_HOST, CLOSED_PORT, makeMonitor, runCheck } from './test-helpers'
import './index'

describe('snmp monitor', () => {
  afterEach(() => {
    vi.doUnmock('net-snmp')
  })

  it('requires hostname and OID', async () => {
    await expect(runCheck(makeMonitor({ type: 'snmp', hostname: null }))).rejects.toThrow(
      'Hostname is required',
    )
    await expect(
      runCheck(makeMonitor({ type: 'snmp', hostname: CLOSED_HOST, snmpOid: '' })),
    ).rejects.toThrow('OID is required')
  })

  it('rejects when the agent does not answer', async () => {
    const monitor = makeMonitor({
      type: 'snmp',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      snmpOid: '1.3.6.1.2.1.1.1.0',
      snmpVersion: '2c',
      snmpCommunity: 'public',
      timeout: 1,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/timed out|ECONNREFUSED|Request/i)
  })

  it('explains how to install the library when net-snmp is missing', async () => {
    vi.doMock('net-snmp', () => {
      throw Object.assign(new Error("Cannot find package 'net-snmp'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'snmp',
      hostname: CLOSED_HOST,
      snmpOid: '1.3.6.1.2.1.1.1.0',
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install net-snmp to use the SNMP monitor/)
  })
})
