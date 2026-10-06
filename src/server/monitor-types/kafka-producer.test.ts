import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLOSED_HOST, CLOSED_PORT, makeMonitor, runCheck } from './test-helpers'
import { kafkaBrokers, kafkaSasl } from './kafka-producer'
import './index'

describe('kafka-producer monitor', () => {
  afterEach(() => {
    vi.doUnmock('kafkajs')
  })

  it('validates brokers and SASL options', () => {
    expect(kafkaBrokers({ kafkaProducerBrokers: [' a:9092 ', '', 'b:9092'] })).toEqual([
      'a:9092',
      'b:9092',
    ])
    expect(() => kafkaBrokers({ kafkaProducerBrokers: [] })).toThrow(
      'At least one broker is required',
    )
    expect(kafkaSasl({ kafkaProducerSaslOptions: null })).toBeUndefined()
    expect(kafkaSasl({ kafkaProducerSaslOptions: '{"mechanism": "None"}' })).toBeUndefined()
    expect(
      kafkaSasl({
        kafkaProducerSaslOptions: '{"mechanism": "plain", "username": "u", "password": "p"}',
      }),
    ).toEqual({ mechanism: 'plain', username: 'u', password: 'p' })
    expect(() => kafkaSasl({ kafkaProducerSaslOptions: '[1]' })).toThrow(
      'SASL options must be a JSON object',
    )
  })

  it('requires brokers and a topic', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'kafka-producer', kafkaProducerBrokers: [] })),
    ).rejects.toThrow('At least one broker is required')
    await expect(
      runCheck(
        makeMonitor({
          type: 'kafka-producer',
          kafkaProducerBrokers: [`${CLOSED_HOST}:${CLOSED_PORT}`],
          kafkaProducerTopic: null,
        }),
      ),
    ).rejects.toThrow('Topic is required')
  })

  it('rejects with a readable message when the brokers are unreachable', async () => {
    const monitor = makeMonitor({
      type: 'kafka-producer',
      kafkaProducerBrokers: [`${CLOSED_HOST}:${CLOSED_PORT}`],
      kafkaProducerTopic: 'marmot',
      kafkaProducerMessage: 'ping',
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Error in producer connection: .+/)
  })

  it('explains how to install the client when kafkajs is missing', async () => {
    vi.doMock('kafkajs', () => {
      throw Object.assign(new Error("Cannot find package 'kafkajs'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'kafka-producer',
      kafkaProducerBrokers: [`${CLOSED_HOST}:${CLOSED_PORT}`],
      kafkaProducerTopic: 'marmot',
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Install kafkajs to use the Kafka Producer monitor/,
    )
  })
})
