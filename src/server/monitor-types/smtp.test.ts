import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { smtpTransportOptions } from './smtp'
import './index'

/** Just enough SMTP for nodemailer's `verify()`: greeting, EHLO, QUIT. */
let server: net.Server
let port: number

beforeAll(async () => {
  server = net.createServer((socket) => {
    socket.write('220 marmot-test ESMTP\r\n')
    socket.on('data', (chunk) => {
      const line = chunk.toString().trim().toUpperCase()
      if (line.startsWith('EHLO') || line.startsWith('HELO')) {
        socket.write('250-marmot-test\r\n250 8BITMIME\r\n')
      } else if (line.startsWith('QUIT')) {
        socket.end('221 Bye\r\n')
      } else {
        socket.write('502 Command not implemented\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('smtp monitor', () => {
  it('maps the security mode to nodemailer flags', () => {
    const base = { hostname: 'mail.local', port: null, ignoreTls: false }
    expect(smtpTransportOptions({ ...base, smtpSecurity: 'secure' }, 1000)).toMatchObject({
      host: 'mail.local',
      port: 25,
      secure: true,
      ignoreTLS: false,
      requireTLS: false,
    })
    expect(smtpTransportOptions({ ...base, smtpSecurity: 'starttls' }, 1000)).toMatchObject({
      secure: false,
      requireTLS: true,
    })
    expect(smtpTransportOptions({ ...base, smtpSecurity: 'nostarttls' }, 1000)).toMatchObject({
      ignoreTLS: true,
    })
    expect(() => smtpTransportOptions({ ...base, hostname: '' }, 1000)).toThrow(
      'Hostname is required',
    )
  })

  it('is UP when the server greets and answers EHLO', async () => {
    const beat = await runCheck(
      makeMonitor({ type: 'smtp', hostname: '127.0.0.1', port, timeout: 5 }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('SMTP connection verifies successfully')
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'smtp',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /SMTP connection doesn't verify: .*ECONNREFUSED/,
    )
  })
})
