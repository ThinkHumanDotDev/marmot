import dgram from 'node:dgram'
import type { AddressInfo } from 'node:net'
import radius from 'radius'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { radiusAttributes } from './radius'
import './index'

const SECRET = 'marmot-secret'

/** Fake RADIUS server: accepts user `alice`, rejects everyone else. */
let server: dgram.Socket
let port: number

beforeAll(async () => {
  server = dgram.createSocket('udp4')
  server.on('message', (msg, rinfo) => {
    const request = radius.decode({ packet: msg, secret: SECRET })
    const code = request.attributes['User-Name'] === 'alice' ? 'Access-Accept' : 'Access-Reject'
    const response = radius.encode_response({ packet: request, code, secret: SECRET })
    server.send(response, rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('radius monitor', () => {
  afterEach(() => {
    vi.doUnmock('radius')
  })

  it('builds the attribute list, skipping empty station ids', () => {
    expect(
      radiusAttributes({
        radiusUsername: 'alice',
        radiusPassword: 'pw',
        radiusCalledStationId: null,
        radiusCallingStationId: '00-11-22',
      }),
    ).toEqual([
      ['User-Name', 'alice'],
      ['User-Password', 'pw'],
      ['Calling-Station-Id', '00-11-22'],
    ])
    expect(() =>
      radiusAttributes({
        radiusUsername: '',
        radiusPassword: null,
        radiusCalledStationId: null,
        radiusCallingStationId: null,
      }),
    ).toThrow('Username is required')
  })

  it('requires the shared secret', async () => {
    await expect(
      runCheck(
        makeMonitor({ type: 'radius', hostname: '127.0.0.1', port, radiusUsername: 'alice' }),
      ),
    ).rejects.toThrow('Shared secret is required')
  })

  it('is UP on Access-Accept', async () => {
    const beat = await runCheck(
      makeMonitor({
        type: 'radius',
        hostname: '127.0.0.1',
        port,
        radiusUsername: 'alice',
        radiusPassword: 'pw',
        radiusSecret: SECRET,
        timeout: 2,
      }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('Access-Accept')
  })

  it('fails on Access-Reject', async () => {
    const monitor = makeMonitor({
      type: 'radius',
      hostname: '127.0.0.1',
      port,
      radiusUsername: 'mallory',
      radiusPassword: 'pw',
      radiusSecret: SECRET,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(`RADIUS Access-Reject from 127.0.0.1:${port}`)
  })

  it('rejects with a readable message when nothing answers', async () => {
    const monitor = makeMonitor({
      type: 'radius',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      radiusUsername: 'alice',
      radiusPassword: 'pw',
      radiusSecret: SECRET,
      timeout: 1,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /RADIUS authentication failed for 127\.0\.0\.1:1: .*(timeout|socket error)/,
    )
  })

  it('explains how to install the codec when radius is missing', async () => {
    vi.doMock('radius', () => {
      throw Object.assign(new Error("Cannot find package 'radius'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'radius',
      hostname: '127.0.0.1',
      port,
      radiusUsername: 'alice',
      radiusSecret: SECRET,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install radius to use the Radius monitor/)
  })
})
