/**
 * MQTT monitor: connects to the broker at `hostname:port`, subscribes to `mqttTopic` and waits for
 * one message. In `keyword` mode the message must contain `mqttSuccessMessage`; in `json-query`
 * mode the JSON payload is evaluated with `jsonPath` (JSONata) and compared with `expectedValue`.
 * The `mqtt` client is an optional dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/mqtt.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. (Condition evaluation is left to the conditions issue.)
 */
import { randomBytes } from 'node:crypto'
import jsonata from 'jsonata'

import type { Monitor } from '@/payload-types'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  errorMessage,
  loadOptionalDriver,
  requireField,
  requireHostname,
} from './util'

export const DEFAULT_MQTT_PORT = 1883

/** `mqtt://host:port` (or the given ws/wss/mqtts scheme) from the monitor's hostname and port. */
export function mqttUrl(hostname: string, port: number | null | undefined): string {
  const base = /^(?:http|mqtt|ws)s?:\/\//i.test(hostname) ? hostname : `mqtt://${hostname}`
  return `${base}:${port || DEFAULT_MQTT_PORT}`
}

export interface MqttMessage {
  topic: string
  message: string
}

/**
 * Connect, subscribe to `topic` and resolve with the first message received. Rejects on
 * connection errors and when no message arrives within `timeoutMs`.
 */
export async function receiveMqttMessage(
  url: string,
  topic: string,
  options: { username?: string | null; password?: string | null; timeoutMs: number },
): Promise<MqttMessage> {
  const mqtt = await loadOptionalDriver(() => import('mqtt'), 'mqtt', 'MQTT')
  return new Promise<MqttMessage>((resolve, reject) => {
    const client = mqtt.connect(url, {
      username: options.username || undefined,
      password: options.password || undefined,
      clientId: `marmot_${randomBytes(4).toString('hex')}`,
      connectTimeout: options.timeoutMs,
      reconnectPeriod: 0,
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.end(true)
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('Timeout, Message not received'))),
      options.timeoutMs,
    )

    client.on('connect', () => {
      client.subscribe(topic, (err) => {
        if (err) finish(() => reject(new Error(`Cannot subscribe topic: ${err.message}`)))
      })
    })
    client.on('error', (err) => finish(() => reject(err)))
    client.on('close', () => {
      // A clean close before any message means the broker went away.
      finish(() => reject(new Error('Connection closed before a message was received')))
    })
    client.on('message', (messageTopic, payload) => {
      finish(() => resolve({ topic: messageTopic, message: payload.toString('utf8') }))
    })
  })
}

/** Keyword mode: the message must contain `mqttSuccessMessage` (any message when it is empty). */
export function checkMqttKeyword(
  monitor: Pick<Monitor, 'mqttTopic' | 'mqttSuccessMessage'>,
  received: MqttMessage,
): string {
  const keyword = monitor.mqttSuccessMessage ?? ''
  if (received.message.includes(keyword)) {
    return `Topic: ${received.topic}; Message: ${received.message}`
  }
  throw new Error(`Message Mismatch - Topic: ${monitor.mqttTopic}; Message: ${received.message}`)
}

/** JSON query mode: JSONata over the JSON payload must equal `expectedValue`. */
export async function checkMqttJsonQuery(
  monitor: Pick<Monitor, 'jsonPath' | 'expectedValue'>,
  received: MqttMessage,
): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(received.message)
  } catch (err) {
    throw new Error(`Message received but it is not valid JSON: ${errorMessage(err)}`)
  }
  const result = await jsonata(requireField(monitor.jsonPath, 'JSON query')).evaluate(parsed)
  if (result !== undefined && result !== null && String(result) === monitor.expectedValue) {
    return 'Message received, expected value is found'
  }
  throw new Error(
    `Message received but value is not equal to expected value, value was: [${String(result)}]`,
  )
}

registerMonitorType({
  name: 'mqtt',
  label: 'MQTT',
  group: 'specific',
  async check(ctx) {
    const hostname = requireHostname(ctx.monitor)
    const topic = requireField(ctx.monitor.mqttTopic, 'Topic')
    const startTime = Date.now()
    const received = await receiveMqttMessage(mqttUrl(hostname, ctx.monitor.port), topic, {
      username: ctx.monitor.mqttUsername,
      password: ctx.monitor.mqttPassword,
      timeoutMs: checkTimeoutMs(ctx.monitor),
    })
    ctx.heartbeat.ping = Date.now() - startTime

    const checkType = ctx.monitor.mqttCheckType || 'keyword'
    if (checkType === 'json-query') {
      ctx.heartbeat.msg = await checkMqttJsonQuery(ctx.monitor, received)
    } else {
      ctx.heartbeat.msg = checkMqttKeyword(ctx.monitor, received)
    }
    ctx.heartbeat.status = 'up'
  },
})
