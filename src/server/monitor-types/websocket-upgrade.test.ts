import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { buildWsOptions } from './websocket-upgrade'
import './index'

let wss: WebSocketServer
let wsPort: number
let httpServer: http.Server
let httpPort: number

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  wsPort = (wss.address() as AddressInfo).port

  // Plain HTTP server that never upgrades: the handshake must fail with its status code.
  httpServer = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  httpPort = (httpServer.address() as AddressInfo).port
})

afterAll(async () => {
  for (const client of wss.clients) client.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

describe('websocket-upgrade monitor', () => {
  afterEach(() => {
    vi.doUnmock('ws')
  })

  it('builds handshake options from headers and auth', () => {
    const options = buildWsOptions(
      {
        headers: '{"Origin": "https://example.com"}',
        authMethod: 'basic',
        basicAuthUser: 'u',
        basicAuthPass: 'p',
        bearerToken: null,
        tlsCert: null,
        tlsKey: null,
        tlsCa: null,
        ignoreTls: true,
      },
      5000,
    )
    expect(options.handshakeTimeout).toBe(5000)
    expect(options.rejectUnauthorized).toBe(false)
    expect(options.headers).toEqual({
      Origin: 'https://example.com',
      Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    })
  })

  it('requires a ws(s):// URL', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'websocket-upgrade', url: 'https://example.com' })),
    ).rejects.toThrow('URL must start with ws:// or wss://')
  })

  it('is UP when the upgrade succeeds and the socket closes cleanly', async () => {
    const beat = await runCheck(
      makeMonitor({ type: 'websocket-upgrade', url: `ws://127.0.0.1:${wsPort}`, timeout: 5 }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('1000 - OK')
  })

  it('fails when the server does not upgrade', async () => {
    const monitor = makeMonitor({
      type: 'websocket-upgrade',
      url: `ws://127.0.0.1:${httpPort}`,
      timeout: 5,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Unexpected server response: 404/)
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'websocket-upgrade',
      url: `ws://${CLOSED_HOST}:${CLOSED_PORT}`,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('explains how to install the client when ws is missing', async () => {
    vi.doMock('ws', () => {
      throw Object.assign(new Error("Cannot find package 'ws'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const monitor = makeMonitor({ type: 'websocket-upgrade', url: `ws://127.0.0.1:${wsPort}` })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Install ws to use the WebSocket Upgrade monitor/,
    )
  })
})
