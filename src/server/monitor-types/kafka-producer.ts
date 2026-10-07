/**
 * Kafka producer monitor: connects to `kafkaProducerBrokers` and produces `kafkaProducerMessage`
 * to `kafkaProducerTopic`; UP when the message is acknowledged. `kafkajs` is an optional
 * dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/util-server.js` (`kafkaProducerAsync`) and the
 * `kafka-producer` branch of `server/model/monitor.js` — Copyright (c) 2021 Louis Lam, MIT License.
 * See THIRD_PARTY_NOTICES.md.
 */
import net from 'node:net'

import type { ISocketFactory, KafkaConfig } from 'kafkajs'

import type { Monitor } from '@/payload-types'
import { guardedNetConnect, outboundGuardActive } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  errorMessage,
  loadOptionalDriver,
  parseJsonObject,
  requireField,
  withAbort,
} from './util'

/** Non-empty broker addresses, or a readable error. */
export function kafkaBrokers(monitor: Pick<Monitor, 'kafkaProducerBrokers'>): string[] {
  const brokers = (monitor.kafkaProducerBrokers ?? []).map((b) => b.trim()).filter(Boolean)
  if (brokers.length === 0) throw new Error('At least one broker is required')
  return brokers
}

/**
 * SASL options from the JSON text field. `{}`, no mechanism or mechanism `None` → no SASL
 * (matches Uptime Kuma's `kafkaProducerSaslOptions`).
 */
export function kafkaSasl(
  monitor: Pick<Monitor, 'kafkaProducerSaslOptions'>,
): KafkaConfig['sasl'] | undefined {
  const options = parseJsonObject(monitor.kafkaProducerSaslOptions, 'SASL options')
  const mechanism = typeof options.mechanism === 'string' ? options.mechanism.trim() : ''
  if (!mechanism || mechanism.toLowerCase() === 'none') return undefined
  return { ...options, mechanism } as unknown as KafkaConfig['sasl']
}

/**
 * kafkajs socket factory (same as its default one) whose sockets pass the outbound address guard.
 * Brokers discovered from cluster metadata connect through it too, so every broker is vetted at
 * connect time.
 */
export const guardedKafkaSocketFactory: ISocketFactory = ({ host, port, ssl, onConnect }) => {
  const socket = guardedNetConnect(
    {
      host,
      port,
      ...(ssl ? { ...(net.isIP(host) ? {} : { servername: host }), ...(ssl as object) } : {}),
    },
    { secure: Boolean(ssl), onConnect },
  )
  socket.setKeepAlive(true, 60_000)
  return socket
}

registerMonitorType({
  name: 'kafka-producer',
  label: 'Kafka Producer',
  group: 'specific',
  async check(ctx) {
    const brokers = kafkaBrokers(ctx.monitor)
    const topic = requireField(ctx.monitor.kafkaProducerTopic, 'Topic')
    const message = ctx.monitor.kafkaProducerMessage ?? ''
    const sasl = kafkaSasl(ctx.monitor)
    const timeout = checkTimeoutMs(ctx.monitor)

    const { Kafka, logLevel } = await loadOptionalDriver(
      () => import('kafkajs'),
      'kafkajs',
      'Kafka Producer',
    )
    const kafka = new Kafka({
      brokers,
      clientId: 'marmot',
      ssl: Boolean(ctx.monitor.kafkaProducerSsl),
      sasl,
      retry: { retries: 0 },
      connectionTimeout: timeout,
      requestTimeout: timeout,
      logLevel: logLevel.NOTHING,
      ...(outboundGuardActive() ? { socketFactory: guardedKafkaSocketFactory } : {}),
    })
    const producer = kafka.producer({
      allowAutoTopicCreation: Boolean(ctx.monitor.kafkaProducerAllowAutoTopicCreation),
      retry: { retries: 0 },
    })

    const startTime = Date.now()
    const disconnect = () => void producer.disconnect().catch(() => undefined)
    try {
      try {
        await withAbort(producer.connect(), ctx.signal, disconnect)
      } catch (err) {
        throw new Error(`Error in producer connection: ${errorMessage(err)}`)
      }
      try {
        await withAbort(
          producer.send({ topic, messages: [{ value: message }] }),
          ctx.signal,
          disconnect,
        )
      } catch (err) {
        throw new Error(`Error sending message: ${errorMessage(err)}`)
      }
    } finally {
      await producer.disconnect().catch(() => undefined)
    }

    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.msg = 'Message sent successfully'
    ctx.heartbeat.status = 'up'
  },
})
