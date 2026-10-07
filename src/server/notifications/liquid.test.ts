import { describe, expect, it } from 'vitest'

import { renderPlaceholders } from '@/lib/placeholders'
import {
  templateVariableNames,
  unknownTemplateVariable,
} from '@/lib/notification-template-variables'
import type { Heartbeat, Monitor } from '@/payload-types'
import type { NotificationSendContext } from '@/server/notification-providers/types'
import { buildNotificationEmail, htmlToText } from './email'
import {
  renderLiquid,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_MAX_OUTPUT,
  TemplateError,
  validateTemplate,
} from './liquid'
import {
  buildDefaultMessage,
  buildTemplateContext,
  renderMessageTemplate,
  renderTemplate,
  type TemplateContext,
} from './message'

const monitor = {
  id: 7,
  name: 'API <prod>',
  type: 'http',
  url: 'https://api.example.com/health',
  description: 'Public & private',
} as unknown as Monitor
const down = {
  id: 1,
  status: 'down',
  msg: 'HTTP 503 "Service Unavailable"',
  ping: null,
  duration: 60,
  retries: 0,
  downCount: 2,
  time: '2026-03-10T10:30:00.000Z',
} as unknown as Heartbeat
const up = { ...down, status: 'up', msg: '200 - OK', ping: 42 } as Heartbeat
const organization = { name: 'Acme', slug: 'acme', logoUrl: null }

const contextFor = (heartbeat: Heartbeat | null, event: 'down' | 'up' | null = null) =>
  buildTemplateContext(buildDefaultMessage(monitor, heartbeat), monitor, heartbeat, 'en', {
    event,
    downtimeSeconds: event === 'up' ? 423 : null,
    organization,
    timeZone: 'Europe/Berlin',
  })

/** The renderer notification templates used before Liquid (#212), for the compatibility check. */
function legacyRender(template: string, context: TemplateContext): string {
  return renderPlaceholders(template, (path) => {
    let current: unknown = context
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object') return ''
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return ''
      current = (current as Record<string, unknown>)[segment]
    }
    if (current === null || current === undefined) return ''
    return typeof current === 'object' ? JSON.stringify(current) : String(current)
  })
}

describe('Liquid message templates', () => {
  it('renders the right {% if %} branch for down and up events', () => {
    const template =
      '{% if event == "down" %}🔴 {{ name }} is down: {{ heartbeat.msg }}{% elsif event == "up" %}🟢 {{ name }} is back after {{ downtime }}{% else %}{{ msg }}{% endif %}'
    expect(renderTemplate(template, contextFor(down, 'down'))).toBe(
      '🔴 API <prod> is down: HTTP 503 "Service Unavailable"',
    )
    expect(renderTemplate(template, contextFor(up, 'up'))).toBe(
      '🟢 API <prod> is back after 7 minutes 3 seconds',
    )
    expect(renderTemplate(template, contextFor(null))).toBe(buildDefaultMessage(monitor, null))
    expect(
      renderTemplate(
        '{% if heartbeat.status == "down" %}DOWN{% else %}UP{% endif %}',
        contextFor(up),
      ),
    ).toBe('UP')
  })

  it('renders existing {{ path }} templates exactly like the earlier renderer', () => {
    const templates = [
      '{{ monitor.name }} ({{monitor.url}}) {{ status }}: {{ heartbeat.msg }} [{{ heartbeat.ping }}ms]',
      '{{ nope }}|{{ nope.deeper }}|{{ monitor.nope }}|{{ msg }}',
      '{"text": "{{ msg }}", "name": "{{ name }}", "url": "{{ hostnameOrURL }}"}',
      '{{ monitor }} / {{ heartbeat }}',
      '{{event}} {{ downtime }} {{ downtimeSeconds }} {{ heartbeat.downCount }}',
      'no placeholders at all, just {braces} and }} and {',
      '{{ heartbeat.time }} {{ monitor.description }} {{ monitor.port }}',
      '',
    ]
    for (const heartbeat of [down, up, null]) {
      const context = contextFor(heartbeat, heartbeat?.status === 'up' ? 'up' : 'down')
      for (const template of templates) {
        expect(renderTemplate(template, context), template).toBe(legacyRender(template, context))
      }
    }
  })

  it('cannot read files, the environment or prototypes', () => {
    const context = contextFor(down, 'down')
    for (const template of [
      '{% include "/etc/passwd" %}',
      '{% render "../../.env" %}',
      '{% layout "x" %}{% block a %}{% endblock %}',
    ]) {
      expect(() => renderTemplate(template, context), template).toThrow(TemplateError)
      expect(() => validateTemplate(template), template).toThrow(TemplateError)
    }
    expect(
      renderTemplate(
        '{{ process.env.DATABASE_URL }}{{ env }}{{ global.process }}{{ constructor.name }}{{ __proto__ }}{{ monitor.constructor.name }}{{ msg.constructor }}',
        context,
      ),
    ).toBe('')
    // Filters outside the allow-list are errors, not silently skipped.
    expect(() => renderTemplate('{{ msg | base64_encode }}', context)).toThrow(/undefined filter/)
    expect(() => renderTemplate('{{ msg | where_exp: "x", "x" }}', context)).toThrow(TemplateError)
  })

  it('stops renders that run too long or build too much', () => {
    const context = contextFor(down, 'down')
    const started = Date.now()
    expect(() =>
      renderTemplate(
        '{% for a in (1..1000) %}{% for b in (1..1000) %}{% for c in (1..1000) %}x{% endfor %}{% endfor %}{% endfor %}',
        context,
      ),
    ).toThrow(TemplateError)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(() =>
      renderTemplate(
        '{% assign s = "xxxxxxxx" %}{% for i in (1..40) %}{% assign s = s | append: s %}{% endfor %}{{ s }}',
        context,
      ),
    ).toThrow(TemplateError)
    expect(() => renderTemplate('{% for i in (1..1000000000) %}{% endfor %}', context)).toThrow(
      TemplateError,
    )
    const big = `{% for i in (1..${Math.ceil(TEMPLATE_MAX_OUTPUT / 10) + 10}) %}0123456789{% endfor %}`
    expect(() => renderTemplate(big, context)).toThrow(
      expect.objectContaining({ code: 'outputTooLong' }),
    )
    expect(() => validateTemplate('x'.repeat(TEMPLATE_MAX_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: 'tooLong' }),
    )
  })

  it('falls back to the default message when a template fails at send time', () => {
    expect(
      renderMessageTemplate(
        '{% for a in (1..1000) %}{% for b in (1..1000) %}{% for c in (1..1000) %}x{% endfor %}{% endfor %}{% endfor %}',
        '[API] [🔴 Down] HTTP 503',
        monitor,
        down,
      ),
    ).toBe('[API] [🔴 Down] HTTP 503')
    expect(renderMessageTemplate('{% if %}', 'a < b', monitor, down, 'en', {}, 'html')).toBe(
      'a &lt; b',
    )
  })

  it('offers the date, duration, json and text filters', () => {
    const context = contextFor(up, 'up')
    const berlin = { timeZone: 'Europe/Berlin' }
    expect(renderTemplate('{{ heartbeat.time | date: "%Y-%m-%d %H:%M" }}', context, berlin)).toBe(
      '2026-03-10 11:30',
    )
    expect(renderTemplate('{{ heartbeat.time | date: "%H:%M" }}', context)).toBe('10:30')
    expect(renderTemplate('{{ heartbeat.time | date: "%H:%M", "UTC" }}', context)).toBe('10:30')
    expect(renderTemplate('{{ heartbeat.localDateTime }} {{ heartbeat.timezone }}', context)).toBe(
      '2026-03-10 11:30:00 Europe/Berlin',
    )
    expect(renderTemplate('{{ downtimeSeconds | duration }}|{{ 3600 | duration }}', context)).toBe(
      '7 minutes 3 seconds|1 hour',
    )
    expect(renderTemplate('{"text": {{ heartbeat.msg | json }}}', contextFor(down))).toBe(
      '{"text": "HTTP 503 \\"Service Unavailable\\""}',
    )
    expect(
      renderTemplate('{{ name | upcase | truncate: 6 }} {{ monitorJSON.name | escape }}', context),
    ).toBe('API... API &lt;prod&gt;')
    expect(renderTemplate('{{ organization.name }} {{ monitor.dashboardUrl }}', context)).toMatch(
      /^Acme https?:\/\/.+\/acme\/monitors\/7$/,
    )
  })

  it('escapes every value in HTML mode, once', () => {
    const context = contextFor(down, 'down')
    expect(
      renderLiquid(
        '<b>{{ monitor.name }}</b> {{ monitor.description | escape }} {{ "<i>ok</i>" | raw }}',
        context,
        { mode: 'html' },
      ),
    ).toBe('<b>API &lt;prod&gt;</b> Public &amp; private <i>ok</i>')
    // Text mode keeps values as they are.
    expect(renderLiquid('{{ monitor.name }}', context)).toBe('API <prod>')
  })

  it('checks templates for unknown variables, allowing assigned and loop variables', () => {
    expect(() => validateTemplate('{{ monitor.nmae }}')).toThrow(
      expect.objectContaining({ code: 'unknownVariable', detail: 'monitor.nmae' }),
    )
    expect(() => validateTemplate('{% if statsu == "x" %}{% endif %}')).toThrow(
      expect.objectContaining({ code: 'unknownVariable', detail: 'statsu' }),
    )
    expect(() => validateTemplate('{{ heartbeat.msg.foo }}')).toThrow(TemplateError)
    expect(() =>
      validateTemplate(
        '{% assign who = monitor.name | upcase %}{{ who }}{% capture x %}{{ msg }}{% endcapture %}{{ x }}{% for part in msg | split: " " %}{{ part }}{{ forloop.index }}{% endfor %}{{ heartbeatJSON["msg"] }}{{ msg.size }}{{ monitor.size }}',
      ),
    ).not.toThrow()
    expect(() => validateTemplate('{{ msg ')).toThrow(expect.objectContaining({ code: 'syntax' }))
    expect(unknownTemplateVariable(['heartbeat', 0, 'x'])).toBeNull()
    expect(templateVariableNames()).toContain('monitor.dashboardUrl')
  })
})

describe('notification email', () => {
  const ctx: NotificationSendContext = {
    config: {},
    message: '[API <prod>] [🔴 Down] HTTP 503',
    monitor,
    heartbeat: down,
    locale: 'en',
    event: 'down',
    organization,
    timeZone: 'UTC',
  }

  it('sends the branded HTML email with a text part by default', () => {
    const email = buildNotificationEmail(ctx, {}, ctx.message)
    expect(email.subject).toBe(ctx.message)
    expect(email.html).toContain('#dc2626')
    expect(email.html).toContain('API &lt;prod&gt;')
    expect(email.html).not.toContain('<prod>')
    expect(email.html).toContain('/acme/monitors/7')
    expect(email.html).toContain('View monitor')
    expect(email.text).toContain(ctx.message)
    expect(email.text).toContain('Time: 2026-03-10 10:30:00 (UTC)')
    expect(email.text).toMatch(/View monitor: https?:\/\/.+\/acme\/monitors\/7/)
  })

  it('renders custom HTML escaped with a generated text part, and falls back on errors', () => {
    const email = buildNotificationEmail(
      ctx,
      {
        subject: '{{ name }}\r\nBcc: x@evil.test',
        html: '<h1>{{ name }}</h1><p>{{ heartbeat.msg }}<br>&amp; more</p><a href="{{ monitor.dashboardUrl }}">Open</a>',
      },
      'unused',
    )
    expect(email.subject).toBe('API <prod> Bcc: x@evil.test')
    expect(email.html).toContain('<h1>API &lt;prod&gt;</h1>')
    expect(email.html).toContain('HTTP 503 &quot;Service Unavailable&quot;')
    expect(email.text).toMatch(
      /^API <prod>\n+HTTP 503 "Service Unavailable"\n& more\n+Open \(https?:\/\/.+\/acme\/monitors\/7\)$/,
    )

    const broken = buildNotificationEmail(ctx, { html: '{% for %}' }, 'subject')
    expect(broken.html).toContain('View monitor')

    const plain = buildNotificationEmail(ctx, { text: '{{ name }}: {{ heartbeat.msg }}' }, 's')
    expect(plain).toEqual({
      subject: 's',
      html: null,
      text: 'API <prod>: HTTP 503 "Service Unavailable"',
    })
  })

  it('turns HTML into readable text', () => {
    expect(
      htmlToText(
        '<html><head><title>T</title><style>p{}</style></head><body><p>Hello&nbsp;<b>world</b></p><ul><li>one</li><li>two</li></ul><a href="https://x.test/a?b=1&amp;c=2">link</a> <a href="https://same.test">https://same.test</a><!-- hidden --></body></html>',
      ),
    ).toBe('Hello world\n\n- one\n- two\nlink (https://x.test/a?b=1&c=2) https://same.test')
  })
})
