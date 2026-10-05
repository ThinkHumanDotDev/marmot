import { describe, expect, it } from 'vitest'

import { makeMonitor, runCheck } from '../../../tests/helpers/monitor-check'
import { parseTailscaleOutput, runTailscalePing } from './tailscale-ping'
import './index'

describe('tailscale-ping monitor', () => {
  it('parses pong lines and reports the round-trip time', () => {
    expect(parseTailscaleOutput('pong from node (100.64.0.1) via DERP(fra) in 23ms\n')).toBe(23)
    expect(parseTailscaleOutput('pong from node (100.64.0.1) via 10.0.0.2:41641 in 1.5ms\n')).toBe(
      2,
    )
  })

  it('turns known failure lines into readable errors', () => {
    expect(() => parseTailscaleOutput('timed out\n')).toThrow(/Ping timed out/)
    expect(() => parseTailscaleOutput('no matching peer\n')).toThrow(/inaccessible due to ACLs/)
    expect(() => parseTailscaleOutput('100.64.0.1 is local Tailscale IP\n')).toThrow(
      /only works if used on other machines/,
    )
    expect(() => parseTailscaleOutput('something odd\n')).toThrow(
      'Unexpected output: "something odd"',
    )
    expect(() => parseTailscaleOutput('\n')).toThrow('No pong in Tailscale ping output')
  })

  it('refuses hostnames that could be mistaken for CLI flags', async () => {
    await expect(runTailscalePing('--help', 1000)).rejects.toThrow('Invalid hostname "--help"')
  })

  it('requires a hostname', async () => {
    await expect(runCheck(makeMonitor({ type: 'tailscale-ping', hostname: '' }))).rejects.toThrow(
      'Hostname is required',
    )
  })

  it('rejects with a readable message when the peer cannot be pinged', async () => {
    // Either the CLI is missing (most CI hosts) or the peer does not exist: both are readable.
    const monitor = makeMonitor({
      type: 'tailscale-ping',
      hostname: 'marmot-test-peer-that-does-not-exist',
      timeout: 5,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/tailscale|peer|Unexpected output|No output/i)
  })
})
