import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { checkMqttJsonQuery, checkMqttKeyword, mqttUrl } from './mqtt'
import './index'

describe('mqtt monitor', () => {
  afterEach(() => {
    vi.doUnmock('mqtt')
  })

  it('builds the broker URL from hostname and port', () => {
    expect(mqttUrl('broker.local', 1883)).toBe('mqtt://broker.local:1883')
    expect(mqttUrl('broker.local', null)).toBe('mqtt://broker.local:1883')
    expect(mqttUrl('mqtts://broker.local', 8883)).toBe('mqtts://broker.local:8883')
    expect(mqttUrl('ws://broker.local', 9001)).toBe('ws://broker.local:9001')
  })

  it('checks keywords in the received message', () => {
    const received = { topic: 'a/b', message: 'status: ok' }
    expect(checkMqttKeyword({ mqttTopic: 'a/#', mqttSuccessMessage: 'ok' }, received)).toBe(
      'Topic: a/b; Message: status: ok',
    )
    expect(checkMqttKeyword({ mqttTopic: 'a/#', mqttSuccessMessage: null }, received)).toMatch(
      /Topic: a\/b/,
    )
    expect(() =>
      checkMqttKeyword({ mqttTopic: 'a/#', mqttSuccessMessage: 'down' }, received),
    ).toThrow('Message Mismatch - Topic: a/#; Message: status: ok')
  })

  it('evaluates JSON queries over the message', async () => {
    const received = { topic: 'a/b', message: '{"temp": {"c": 21}}' }
    await expect(
      checkMqttJsonQuery({ jsonPath: 'temp.c', expectedValue: '21' }, received),
    ).resolves.toBe('Message received, expected value is found')
    await expect(
      checkMqttJsonQuery({ jsonPath: 'temp.c', expectedValue: '22' }, received),
    ).rejects.toThrow(/value was: \[21\]/)
    await expect(
      checkMqttJsonQuery({ jsonPath: 'temp.c', expectedValue: '21' }, { topic: 'a', message: 'x' }),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('requires hostname and topic', async () => {
    await expect(runCheck(makeMonitor({ type: 'mqtt', hostname: null }))).rejects.toThrow(
      'Hostname is required',
    )
    await expect(
      runCheck(makeMonitor({ type: 'mqtt', hostname: CLOSED_HOST, mqttTopic: '' })),
    ).rejects.toThrow('Topic is required')
  })

  it('rejects with a readable message when the broker is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'mqtt',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      mqttTopic: 'marmot/test',
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/ECONNREFUSED|closed|Timeout/)
  })

  it('explains how to install the client when mqtt is missing', async () => {
    vi.doMock('mqtt', () => {
      throw Object.assign(new Error("Cannot find package 'mqtt'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const monitor = makeMonitor({
      type: 'mqtt',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      mqttTopic: 'marmot/test',
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install mqtt to use the MQTT monitor/)
  })
})
