import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { formatSftpError, sftpConnectOptions } from './sftp'
import './index'

describe('sftp monitor', () => {
  afterEach(() => {
    vi.doUnmock('ssh2-sftp-client')
  })

  it('formats driver errors for humans', () => {
    expect(formatSftpError({ code: 'ECONNREFUSED' }, 'h', 22)).toBe(
      'Connection refused — h:22 actively rejected the connection',
    )
    expect(formatSftpError({ code: 'ENOTFOUND' }, 'h', 22)).toMatch(/Host not found/)
    expect(
      formatSftpError(
        { message: 'getConnection: All configured authentication methods failed' },
        'h',
        22,
      ),
    ).toBe('All configured authentication methods failed')
    expect(formatSftpError({ message: 'getConnection: ' }, 'h', 22)).toMatch(
      /unreachable or offline/,
    )
  })

  it('builds connect options for password and key authentication', () => {
    const base = { hostname: 'files.local', port: null, sshUsername: 'bob' }
    expect(
      sftpConnectOptions(
        {
          ...base,
          sshAuthMethod: 'password',
          sshPassword: 'pw',
          sshPrivateKey: null,
          sshPassphrase: null,
        },
        3000,
      ),
    ).toMatchObject({
      host: 'files.local',
      port: 22,
      username: 'bob',
      password: 'pw',
      readyTimeout: 3000,
    })
    expect(
      sftpConnectOptions(
        {
          ...base,
          sshAuthMethod: 'privateKey',
          sshPassword: null,
          sshPrivateKey: 'KEY',
          sshPassphrase: 'pp',
        },
        3000,
      ),
    ).toMatchObject({ privateKey: 'KEY', passphrase: 'pp' })
    expect(() =>
      sftpConnectOptions(
        {
          ...base,
          sshAuthMethod: 'privateKey',
          sshPassword: null,
          sshPrivateKey: null,
          sshPassphrase: null,
        },
        3000,
      ),
    ).toThrow(/SSH private key .* is required/)
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'sftp',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      sshUsername: 'bob',
      sshAuthMethod: 'password',
      sshPassword: 'pw',
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      `Connection refused — ${CLOSED_HOST}:${CLOSED_PORT} actively rejected the connection`,
    )
  })

  it('explains how to install the client when ssh2-sftp-client is missing', async () => {
    vi.doMock('ssh2-sftp-client', () => {
      throw Object.assign(new Error("Cannot find package 'ssh2-sftp-client'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'sftp',
      hostname: CLOSED_HOST,
      sshUsername: 'bob',
      sshAuthMethod: 'password',
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Install ssh2-sftp-client to use the SFTP monitor/,
    )
  })
})
