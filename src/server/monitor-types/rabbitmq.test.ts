import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLOSED_HOST,
  closedTcpPort,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { alarmsUrl, rabbitmqNodes } from './rabbitmq'
import './index'

let server: http.Server
let base: string
let lastAuth: string | undefined

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization
    if (req.url === '/api/health/checks/alarms/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
    } else if (req.url === '/alarmed/api/health/checks/alarms/') {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"status":"failed","reason":"There are alarms active in the cluster: memory"}')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('rabbitmq monitor', () => {
  it('validates node URLs and builds the health check URL', () => {
    expect(rabbitmqNodes({ rabbitmqNodes: [' http://a:15672 ', ''] })).toEqual(['http://a:15672'])
    expect(() => rabbitmqNodes({ rabbitmqNodes: [] })).toThrow('No RabbitMQ nodes configured')
    expect(() => rabbitmqNodes({ rabbitmqNodes: ['a:15672'] })).toThrow(/Invalid RabbitMQ node URL/)
    expect(alarmsUrl('https://node1:15672')).toBe('https://node1:15672/api/health/checks/alarms/')
    expect(alarmsUrl('https://node1/rabbit')).toBe('https://node1/rabbit/api/health/checks/alarms/')
  })

  it('is UP when a node reports no alarms, sending basic auth', async () => {
    const beat = await runCheck(
      makeMonitor({
        type: 'rabbitmq',
        rabbitmqNodes: [base],
        rabbitmqUsername: 'guest',
        rabbitmqPassword: 'guest',
        timeout: 5,
      }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('Node is reachable and there are no alerts in the cluster')
    expect(lastAuth).toBe(`Basic ${Buffer.from('guest:guest').toString('base64')}`)
  })

  it('surfaces the alarm reason and falls through to the next node', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'rabbitmq', rabbitmqNodes: [`${base}/alarmed`], timeout: 5 })),
    ).rejects.toThrow(
      'All 1 nodes failed because Node 1: There are alarms active in the cluster: memory',
    )

    const beat = await runCheck(
      makeMonitor({ type: 'rabbitmq', rabbitmqNodes: [`${base}/alarmed`, base], timeout: 5 }),
    )
    expect(beat.msg).toBe('One of the 2 nodes is reachable and there are no alerts in the cluster')
  })

  it('rejects with a readable message when the node is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'rabbitmq',
      rabbitmqNodes: [`http://${CLOSED_HOST}:${await closedTcpPort()}`],
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /All 1 nodes failed because Node 1: .*ECONNREFUSED/,
    )
  })
})
