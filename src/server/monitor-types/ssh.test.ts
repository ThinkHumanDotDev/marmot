import { generateKeyPairSync, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Server, utils, type Connection, type ParsedKey } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { assertSshCommand, findSshBanner, sshAuthOptions } from './ssh'
import { CLOSED_HOST, CLOSED_PORT, makeMonitor, runCheck } from './test-helpers'
import './index'

const rsaPem = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey

const hostKey = rsaPem()
const clientKey = rsaPem()
const clientPublic = utils.parseKey(clientKey)
if (clientPublic instanceof Error) throw clientPublic

/**
 * In-process SSH server: user `bob` with password `secret` or `clientKey`. Commands: `echo <text>`
 * prints the text, `exit <n>` exits with n, anything else exits with 127.
 */
let server: Server
let port: number

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey], ident: 'MarmotTest_1.0' }, (client: Connection) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'bob') return ctx.reject()
      if (ctx.method === 'password' && ctx.password === 'secret') return ctx.accept()
      if (ctx.method === 'publickey') {
        const expected = clientPublic as ParsedKey
        const offered = ctx.key.data
        const ours = expected.getPublicSSH()
        if (offered.length !== ours.length || !timingSafeEqual(offered, ours)) return ctx.reject()
        if (!ctx.signature) return ctx.accept() // key probe
        if (expected.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept()
      }
      ctx.reject()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          const [cmd, ...rest] = info.command.split(' ')
          if (cmd === 'echo') {
            stream.write(`${rest.join(' ')}\n`)
            stream.exit(0)
          } else if (cmd === 'exit') {
            stream.stderr.write('failing on purpose\n')
            stream.exit(Number(rest[0]))
          } else {
            stream.exit(127)
          }
          stream.end()
        })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const sshMonitor = (over: Partial<Monitor> = {}) =>
  makeMonitor({ type: 'ssh', hostname: '127.0.0.1', port, timeout: 10, ...over })

describe('ssh helpers', () => {
  it('finds the identification line after other banner lines', () => {
    expect(findSshBanner('Welcome\r\nSSH-2.0-OpenSSH_9.6\r\n')).toBe('SSH-2.0-OpenSSH_9.6')
    expect(findSshBanner('SSH-2.0-partial')).toBeNull()
  })

  it('builds password and key credentials', () => {
    const base = { sshUsername: 'bob', sshPassphrase: null }
    expect(
      sshAuthOptions({
        ...base,
        sshAuthMethod: 'password',
        sshPassword: 'pw',
        sshPrivateKey: null,
      }),
    ).toEqual({ username: 'bob', password: 'pw' })
    expect(() =>
      sshAuthOptions({
        ...base,
        sshAuthMethod: 'privateKey',
        sshPassword: null,
        sshPrivateKey: null,
      }),
    ).toThrow(/SSH private key .* is required/)
  })

  it('judges exit code and output', () => {
    const ok = { code: 0, signal: null, stdout: 'active\n', stderr: '' }
    expect(() => assertSshCommand(ok, 0, 'active')).not.toThrow()
    expect(() => assertSshCommand(ok, 0, 'inactive')).toThrow(/does not contain "inactive"/)
    expect(() => assertSshCommand({ ...ok, code: 3, stderr: 'boom' }, 0, null)).toThrow(
      'The command exited with 3, expected 0: boom',
    )
    expect(() => assertSshCommand({ ...ok, code: null, signal: 'KILL' }, 0, null)).toThrow(
      /without an exit code \(signal KILL\)/,
    )
  })
})

describe('ssh monitor', () => {
  it('reads the banner without credentials', async () => {
    const beat = await runCheck(sshMonitor())
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('SSH-2.0-MarmotTest_1.0')
  })

  it('logs in with a password and runs a command', async () => {
    const beat = await runCheck(
      sshMonitor({
        sshUsername: 'bob',
        sshAuthMethod: 'password',
        sshPassword: 'secret',
        sshCommand: 'echo all good',
        sshExpectedOutput: 'all good',
      }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('SSH-2.0-MarmotTest_1.0, authenticated as bob, command exited with 0')
  })

  it('logs in with a private key', async () => {
    const beat = await runCheck(
      sshMonitor({ sshUsername: 'bob', sshAuthMethod: 'privateKey', sshPrivateKey: clientKey }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('SSH-2.0-MarmotTest_1.0, authenticated as bob')
  })

  it('fails on a wrong password', async () => {
    await expect(
      runCheck(sshMonitor({ sshUsername: 'bob', sshAuthMethod: 'password', sshPassword: 'nope' })),
    ).rejects.toThrow(/^Authentication failed for bob/)
  })

  it('fails when the command exits with an unexpected code', async () => {
    await expect(
      runCheck(
        sshMonitor({
          sshUsername: 'bob',
          sshAuthMethod: 'password',
          sshPassword: 'secret',
          sshCommand: 'exit 2',
          sshExpectedExitCode: 0,
        }),
      ),
    ).rejects.toThrow('The command exited with 2, expected 0: failing on purpose')
  })

  it('accepts a non-zero exit code when it is the expected one', async () => {
    const beat = await runCheck(
      sshMonitor({
        sshUsername: 'bob',
        sshAuthMethod: 'password',
        sshPassword: 'secret',
        sshCommand: 'exit 3',
        sshExpectedExitCode: 3,
      }),
    )
    expect(beat.status).toBe('up')
  })

  it('rejects with a readable message when nothing listens', async () => {
    await expect(
      runCheck(sshMonitor({ hostname: CLOSED_HOST, port: CLOSED_PORT })),
    ).rejects.toThrow(`Connection refused — ${CLOSED_HOST}:${CLOSED_PORT}`)
  })
})
