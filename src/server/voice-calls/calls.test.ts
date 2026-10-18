import { describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { buildSpeech, gatherTwiml, hangupTwiml, sayLanguage, speakable } from './calls'
import type { VoiceCallState } from './store'

const state = (patch: Partial<VoiceCallState> = {}): VoiceCallState => ({
  id: 'A'.repeat(22),
  accountSid: 'AC1',
  authToken: 'token',
  fromNumber: '+15005550006',
  toNumber: '+14155550123',
  voice: null,
  language: 'en-US',
  locale: 'en',
  speech: 'Marmot alert. API is down.',
  incidentId: '1',
  organizationId: '1',
  notificationId: '1',
  test: false,
  attempt: 1,
  maxAttempts: 3,
  retryDelaySeconds: 60,
  callSid: null,
  plays: 0,
  silentPlays: 0,
  machine: false,
  acknowledged: false,
  ...patch,
})

describe('phone-call speech', () => {
  it('turns a notification message into something a speech engine can read', () => {
    expect(speakable('[API] [🔴 Down] HTTP 503\nAcknowledge: https://x.test/ack/abc')).toBe(
      'API. Down. HTTP 503 Acknowledge:',
    )
  })

  it('announces an incident, a reminder and other messages', () => {
    const monitor = { name: 'API <prod>' } as Monitor
    expect(
      buildSpeech(
        {
          message: '',
          monitor,
          heartbeat: { msg: 'HTTP 503' } as never,
          event: 'down',
          incidentId: '1',
        },
        'en',
      ),
    ).toBe('Marmot alert. API <prod> is down. Reason: HTTP 503.')
    expect(
      buildSpeech(
        { message: '', monitor, heartbeat: null, event: 'reminder', incidentId: '1' },
        'en',
      ),
    ).toBe('Marmot alert. API <prod> is still down.')
    expect(
      buildSpeech(
        { message: '[API] [✅ Up] OK', monitor, heartbeat: null, event: 'up', incidentId: null },
        'en',
      ),
    ).toBe('Marmot alert. API. Up. OK')
    expect(buildSpeech({ message: 'x', monitor: null, heartbeat: null, test: true }, 'en')).toBe(
      'This is a test call from Marmot.',
    )
  })

  it('follows the organization language unless the channel sets one', () => {
    expect(sayLanguage(undefined, 'de')).toBe('de-DE')
    expect(sayLanguage('  ', 'fr')).toBe('fr-FR')
    expect(sayLanguage('en-GB', 'de')).toBe('en-GB')
  })
})

describe('phone-call TwiML', () => {
  it('escapes the spoken text and attributes', () => {
    const xml = gatherTwiml(
      state({ speech: 'API <prod> & "co" is down.', voice: 'Polly."x"' }),
      'Sorry <b>',
    )
    expect(xml).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?><Response><Say voice="Polly.&quot;x&quot;"/,
    )
    expect(xml).toContain('Sorry &lt;b&gt;</Say><Gather')
    expect(xml).toContain('API &lt;prod&gt; &amp; &quot;co&quot; is down. Press 1')
    expect(xml).not.toContain('<prod>')
    expect(xml).toMatch(/<\/Gather><Redirect method="POST">http.*\/gather<\/Redirect><\/Response>$/)
  })

  it('prompts by kind of call', () => {
    expect(gatherTwiml(state())).toContain('Press 1 to acknowledge the incident')
    expect(gatherTwiml(state({ incidentId: null, test: true }))).toContain('Press 1 to confirm')
    expect(gatherTwiml(state({ incidentId: null }))).toContain(
      'Press 2 to hear this message again.</Say>',
    )
  })

  it('hangs up, saying goodbye when asked', () => {
    expect(hangupTwiml(null)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    )
    expect(hangupTwiml(state(), 'Bye.')).toContain('<Say language="en-US">Bye.</Say><Hangup/>')
  })
})
