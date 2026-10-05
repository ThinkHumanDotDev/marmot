import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import './index'

describe('mongodb monitor', () => {
  afterEach(() => {
    vi.doUnmock('mongodb')
  })

  it('requires a connection string', async () => {
    await expect(
      runCheck(makeMonitor({ type: 'mongodb', databaseConnectionString: null })),
    ).rejects.toThrow('Connection string is required')
  })

  it('rejects a command that is not a JSON object', async () => {
    const monitor = makeMonitor({
      type: 'mongodb',
      databaseConnectionString: `mongodb://${CLOSED_HOST}:${CLOSED_PORT}/test`,
      databaseQuery: '[1, 2]',
    })
    await expect(runCheck(monitor)).rejects.toThrow('Command must be a JSON object')
  })

  it('rejects with a readable message when the server is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'mongodb',
      databaseConnectionString: `mongodb://${CLOSED_HOST}:${CLOSED_PORT}/test?directConnection=true`,
      timeout: 2,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/MongoDB connection\/command failed: .+/)
  })

  it('explains how to install the driver when mongodb is missing', async () => {
    vi.doMock('mongodb', () => {
      throw Object.assign(new Error("Cannot find package 'mongodb'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'mongodb',
      databaseConnectionString: `mongodb://${CLOSED_HOST}:${CLOSED_PORT}/test`,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install mongodb to use the MongoDB monitor/)
  })
})
