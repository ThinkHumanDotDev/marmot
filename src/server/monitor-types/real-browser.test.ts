import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import { assertHttpUrl } from './real-browser'
import './index'

describe('real-browser monitor', () => {
  afterEach(() => {
    vi.doUnmock('playwright-core')
  })

  it('only allows http(s) pages', () => {
    expect(assertHttpUrl('https://example.com/').href).toBe('https://example.com/')
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(/only http and https are allowed/)
    expect(() => assertHttpUrl('not a url')).toThrow('Invalid URL "not a url"')
  })

  it('requires a remote browser URL instead of launching Chromium', async () => {
    const monitor = makeMonitor({
      type: 'real-browser',
      url: 'https://example.com',
      remoteBrowser: null,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/Remote browser URL is required/)
  })

  it('rejects with a readable message when the remote browser is unreachable', async () => {
    const monitor = makeMonitor({
      type: 'real-browser',
      url: 'https://example.com',
      remoteBrowser: `ws://${CLOSED_HOST}:${CLOSED_PORT}`,
      timeout: 3,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/ECONNREFUSED|connect|Timeout/i)
  })

  it('explains how to install playwright-core when it is missing', async () => {
    vi.doMock('playwright-core', () => {
      throw Object.assign(new Error("Cannot find package 'playwright-core'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })
    const monitor = makeMonitor({
      type: 'real-browser',
      url: 'https://example.com',
      remoteBrowser: `ws://${CLOSED_HOST}:${CLOSED_PORT}`,
    })
    await expect(runCheck(monitor)).rejects.toThrow(
      /Install playwright-core to use the Browser Engine monitor/,
    )
  })
})
