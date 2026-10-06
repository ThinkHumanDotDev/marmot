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
import {
  guardedLookup,
  literalTargetDenial,
  outboundGuardActive,
  resolveGuardedTarget,
} from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  errorMessage,
  loadOptionalDriver,
  requireField,
  requireHostname,
  responseExcerpt,
} from './util'

export const DEFAULT_MQTT_PORT = 1883

/** `mqtt://host:port` (or the given ws/wss/mqtts scheme) from the monitor's hostname and port. */
export function mqttUrl(hostname: string, port: number | null | undefined): string {
  const base = /^(?:http|mqtt|ws)s?:\/\//i.test(hostname) ? hostname : `mqtt://${hostname}`
  return `${base}:${port || DEFAULT_MQTT_PORT}`
}

/**
 * Outbound address guard for an MQTT URL. TCP/TLS: the URL is rewritten to the vetted address and
 * TLS keeps verifying the name. WebSocket transports: the `ws` client resolves through
 * `guardedLookup` at connect time (literals are checked here). Unchanged when the guard is off.
 */
export async function pinMqttUrl(
  url: string,
): Promise<{ url: string; connectOptions: Record<string, unknown> }> {
  if (!outboundGuardActive()) return { url, connectOptions: {} }
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (/^(?:wss?|https?):$/i.test(parsed.protocol)) {
    const denial = literalTargetDenial(host)
    if (denial) throw new Error(denial)
    return { url, connectOptions: { wsOptions: { lookup: guardedLookup } } }
  }
  const vetted = await resolveGuardedTarget(host)
  if (!vetted || vetted.address === host) return { url, connectOptions: {} }
  parsed.hostname = vetted.family === 6 ? `[${vetted.address}]` : vetted.address
  return { url: parsed.toString(), connectOptions: { servername: host } }
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
  options: {
    username?: string | null
    password?: string | null
    timeoutMs: number
    /** Extra client options (see `pinMqttUrl`). */
    connectOptions?: Record<string, unknown>
  },
): Promise<MqttMessage> {
  const mqtt = await loadOptionalDriver(() => import('mqtt'), 'mqtt', 'MQTT')
  return new Promise<MqttMessage>((resolve, reject) => {
    const client = mqtt.connect(url, {
      ...options.connectOptions,
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
    return `Topic: ${received.topic}; Message: ${responseExcerpt(received.message)}`
  }
  throw new Error(
    `Message Mismatch - Topic: ${monitor.mqttTopic}; Message: ${responseExcerpt(received.message)}`,
  )
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
    `Message received but value is not equal to expected value, value was: [${responseExcerpt(result)}]`,
  )
}

registerMonitorType({
  name: 'mqtt',
  label: 'MQTT',
  group: 'specific',
  async check(ctx) {
    const hostname = requireHostname(ctx.monitor)
    const topic = requireField(ctx.monitor.mqttTopic, 'Topic')
    const { url, connectOptions } = await pinMqttUrl(mqttUrl(hostname, ctx.monitor.port))
    const startTime = Date.now()
    const received = await receiveMqttMessage(url, topic, {
      username: ctx.monitor.mqttUsername,
      password: ctx.monitor.mqttPassword,
      timeoutMs: checkTimeoutMs(ctx.monitor),
      connectOptions,
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
