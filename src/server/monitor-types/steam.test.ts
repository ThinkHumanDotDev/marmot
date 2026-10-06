import type { Payload } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetInstanceSettingsCache } from '@/server/settings'

import { makeMonitor, runCheck } from './test-helpers'
import { resolveSteamHostname, STEAM_API_URL } from './steam'
import './index'

/** Payload stub exposing only what `getInstanceSettings` reads. */
const payloadWithKey = (steamApiKey: string | null): Partial<Payload> =>
  ({
    findGlobal: vi.fn(async () => ({ steamApiKey })),
    logger: { warn: vi.fn() },
  }) as unknown as Partial<Payload>

describe('steam monitor', () => {
  beforeEach(() => resetInstanceSettingsCache())
  afterEach(() => {
    vi.restoreAllMocks()
    resetInstanceSettingsCache()
  })

  it('passes IP literals through and resolves hostnames', async () => {
    expect(await resolveSteamHostname('1.2.3.4')).toBe('1.2.3.4')
    expect(await resolveSteamHostname('localhost')).toMatch(/^(127\.0\.0\.1|::1)$/)
    await expect(resolveSteamHostname('does-not-exist.invalid')).rejects.toThrow(
      /Unable to resolve Steam server hostname "does-not-exist.invalid"/,
    )
  })

  it('requires hostname and port', async () => {
    await expect(runCheck(makeMonitor({ type: 'steam', hostname: '' }))).rejects.toThrow(
      'Hostname is required',
    )
    await expect(
      runCheck(makeMonitor({ type: 'steam', hostname: '1.2.3.4', port: null })),
    ).rejects.toThrow('Port is required')
  })

  it('explains that the Steam API key is missing', async () => {
    const monitor = makeMonitor({ type: 'steam', hostname: '1.2.3.4', port: 27015 })
    await expect(runCheck(monitor, { payload: payloadWithKey(null) })).rejects.toThrow(
      /Steam API key is not configured/,
    )
  })

  it('is UP with the server name when the Steam API lists the server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: { servers: [{ name: 'Marmot Arena' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const monitor = makeMonitor({ type: 'steam', hostname: '127.0.0.1', port: 27015, timeout: 2 })
    const beat = await runCheck(monitor, { payload: payloadWithKey('KEY123') })
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('Marmot Arena')
    const requested = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(`${requested.origin}${requested.pathname}`).toBe(STEAM_API_URL)
    expect(requested.searchParams.get('filter')).toBe('addr\\127.0.0.1:27015')
    expect(requested.searchParams.get('key')).toBe('KEY123')
  })

  it('fails when the server is not listed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response: {} }), { status: 200 }),
    )
    const monitor = makeMonitor({ type: 'steam', hostname: '1.2.3.4', port: 27015, timeout: 2 })
    await expect(runCheck(monitor, { payload: payloadWithKey('KEY123') })).rejects.toThrow(
      'Server not found on Steam',
    )
  })

  it('reports Steam API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    )
    const monitor = makeMonitor({ type: 'steam', hostname: '1.2.3.4', port: 27015, timeout: 2 })
    await expect(runCheck(monitor, { payload: payloadWithKey('KEY123') })).rejects.toThrow(
      'Steam API returned 403 - Forbidden',
    )
  })
})
