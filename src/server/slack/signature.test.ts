import { describe, expect, it } from 'vitest'

import { parseSlackAppTarget, slackAppTarget } from '@/lib/slack-app'
import { normalizeTarget } from '@/lib/status-page-subscribers'

import { unwrapSlackLink } from './pages'
import { slackSignature, verifySlackSignature } from './signature'

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)
const TS = Math.floor(NOW / 1000)
const BODY = 'token=x&team_id=T1&command=%2Fmarmot&text=help'

const headers = (signature: string | null, timestamp: string | number | null = TS) => {
  const h = new Headers()
  if (signature !== null) h.set('x-slack-signature', signature)
  if (timestamp !== null) h.set('x-slack-request-timestamp', String(timestamp))
  return h
}

describe('Slack request signatures', () => {
  it('matches Slack’s documented example', () => {
    // https://api.slack.com/authentication/verifying-requests-from-slack
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c'
    expect(slackSignature(SECRET, 1531420618, body)).toBe(
      'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    )
  })

  it('accepts a genuine request', () => {
    expect(verifySlackSignature(SECRET, headers(slackSignature(SECRET, TS, BODY)), BODY, NOW)).toBe(
      null,
    )
  })

  it('rejects unsigned requests', () => {
    expect(verifySlackSignature(SECRET, headers(null), BODY, NOW)).toBe('missing')
    expect(verifySlackSignature(SECRET, headers('v0=abc', null), BODY, NOW)).toBe('missing')
    expect(verifySlackSignature(SECRET, headers('v0=abc', 'soon'), BODY, NOW)).toBe('missing')
  })

  it('rejects forged and tampered requests', () => {
    expect(
      verifySlackSignature(SECRET, headers(slackSignature('other-secret', TS, BODY)), BODY, NOW),
    ).toBe('mismatch')
    expect(
      verifySlackSignature(SECRET, headers(slackSignature(SECRET, TS, BODY)), `${BODY}&x=1`, NOW),
    ).toBe('mismatch')
    // The timestamp is part of what is signed.
    expect(
      verifySlackSignature(SECRET, headers(slackSignature(SECRET, TS, BODY), TS - 1), BODY, NOW),
    ).toBe('mismatch')
    expect(verifySlackSignature(SECRET, headers('v0=short'), BODY, NOW)).toBe('mismatch')
  })

  it('rejects replays older (or newer) than five minutes', () => {
    const old = TS - 301
    expect(
      verifySlackSignature(SECRET, headers(slackSignature(SECRET, old, BODY), old), BODY, NOW),
    ).toBe('stale')
    const future = TS + 301
    expect(
      verifySlackSignature(
        SECRET,
        headers(slackSignature(SECRET, future, BODY), future),
        BODY,
        NOW,
      ),
    ).toBe('stale')
    const recent = TS - 299
    expect(
      verifySlackSignature(
        SECRET,
        headers(slackSignature(SECRET, recent, BODY), recent),
        BODY,
        NOW,
      ),
    ).toBe(null)
  })
})

describe('Slack app subscriber targets', () => {
  it('round-trips workspace and channel ids', () => {
    expect(parseSlackAppTarget(slackAppTarget('T123', 'C456'))).toEqual({
      teamId: 'T123',
      channelId: 'C456',
    })
    expect(parseSlackAppTarget('slack://T123/C456/extra')).toBeNull()
    expect(parseSlackAppTarget('https://hooks.slack.com/services/x')).toBeNull()
  })

  it('accepts app targets only when the Slack app writes them', () => {
    expect(normalizeTarget('slack', 'slack://T123/C456')).toEqual({
      ok: false,
      error: 'invalidTarget',
    })
    expect(normalizeTarget('slack', 'slack://T123/C456', { slackApp: true })).toEqual({
      ok: true,
      target: 'slack://T123/C456',
    })
    expect(normalizeTarget('webhook', 'slack://T123/C456', { slackApp: true }).ok).toBe(false)
  })

  it('unwraps links as Slack formats them', () => {
    expect(unwrapSlackLink('<https://status.acme.com|status.acme.com>')).toBe(
      'https://status.acme.com',
    )
    expect(unwrapSlackLink('<https://status.acme.com>')).toBe('https://status.acme.com')
    expect(unwrapSlackLink(' acme ')).toBe('acme')
  })
})
