import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLOSED_HOST, CLOSED_PORT, makeMonitor, runCheck } from './test-helpers'
import './index'

describe('gamedig monitor', () => {
  afterEach(() => {
    vi.doUnmock('gamedig')
  })

  it('requires hostname and game', async () => {
    await expect(runCheck(makeMonitor({ type: 'gamedig', hostname: '' }))).rejects.toThrow(
      'Hostname is required',
    )
    await expect(
      runCheck(
        makeMonitor({ type: 'gamedig', hostname: CLOSED_HOST, port: CLOSED_PORT, game: '' }),
      ),
    ).rejects.toThrow('Game is required')
  })

  it('rejects unknown game ids with GameDig’s message', async () => {
    const monitor = makeMonitor({
      type: 'gamedig',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      game: 'not-a-real-game-id',
      timeout: 1,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/not-a-real-game-id|Invalid game/i)
  })

  it('rejects with a readable message when the server does not answer', async () => {
    const monitor = makeMonitor({
      type: 'gamedig',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      game: 'minecraft',
      gamedigGivenPortOnly: true,
      timeout: 1,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/.+/)
  })

  it('explains how to install the library when gamedig is missing', async () => {
    vi.doMock('gamedig', () => {
      throw Object.assign(new Error("Cannot find package 'gamedig'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'gamedig',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      game: 'minecraft',
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Install gamedig to use the GameDig monitor/)
  })
})
