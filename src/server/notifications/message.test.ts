import { describe, expect, it } from 'vitest'

import type { Heartbeat, Monitor } from '@/payload-types'
import {
  buildDefaultMessage,
  buildTemplateContext,
  buildTestMessage,
  renderMessageTemplate,
  renderTemplate,
} from './message'
import { TemplateError } from './liquid'

const monitor = {
  id: 1,
  name: 'Site',
  type: 'http',
  url: 'https://example.com',
} as unknown as Monitor
const down = {
  id: 2,
  status: 'down',
  msg: 'timeout',
  time: '2026-01-01T00:00:00.000Z',
} as unknown as Heartbeat
const up = { ...down, status: 'up', msg: '200 - OK', ping: 42 } as Heartbeat

describe('default message', () => {
  it('formats [name] [status] msg like Uptime Kuma', () => {
    expect(buildDefaultMessage(monitor, down)).toBe('[Site] [🔴 Down] timeout')
    expect(buildDefaultMessage(monitor, up)).toBe('[Site] [✅ Up] 200 - OK')
    expect(buildDefaultMessage(monitor, { ...down, status: 'pending' } as Heartbeat)).toBe(
      '[Site] [⚠️ Pending] timeout',
    )
    expect(buildDefaultMessage(monitor, { ...down, status: 'maintenance' } as Heartbeat)).toBe(
      '[Site] [🔧 Maintenance] timeout',
    )
    expect(buildDefaultMessage(monitor, { ...down, msg: '' } as Heartbeat)).toBe(
      '[Site] [🔴 Down] N/A',
    )
    expect(buildTestMessage('Ops')).toBe('[Marmot] [⚠️ Test] "Ops" is configured correctly.')
  })
})

describe('template renderer', () => {
  it('substitutes allow-listed dotted paths and blanks unknown ones', () => {
    const out = renderMessageTemplate(
      '{{ monitor.name }} ({{monitor.url}}) {{ status }}: {{ heartbeat.msg }} [{{ heartbeat.ping }}ms] {{ nope.x }}|{{ msg }}',
      '[Site] [✅ Up] 200 - OK',
      monitor,
      up,
    )
    expect(out).toBe('Site (https://example.com) ✅ Up: 200 - OK [42ms] |[Site] [✅ Up] 200 - OK')
  })

  it('never evaluates expressions or reaches outside the context', () => {
    const ctx = buildTemplateContext('m', monitor, up)
    expect(renderTemplate('{{ constructor.name }}', ctx)).toBe('')
    expect(renderTemplate('{{ __proto__.polluted }}', ctx)).toBe('')
    expect(renderTemplate('{{ monitor.toString }}', ctx)).toBe('')
    expect(renderTemplate('{{ process.env }}{{ globalThis }}{{ require }}', ctx)).toBe('')
    // Invalid Liquid is an error for the renderer and the default message for a delivery.
    expect(() => renderTemplate('{{ 1 + 1 }} {% if %}', ctx)).toThrow(TemplateError)
    expect(renderMessageTemplate('{{ 1 + 1 }} {% if %}', 'default text', monitor, up)).toBe(
      'default text',
    )
  })

  it('provides test defaults when monitor and heartbeat are null', () => {
    expect(
      renderMessageTemplate('{{ name }} / {{ hostnameOrURL }} / {{ status }}', 'x', null, null),
    ).toBe('Monitor Name not available / testing.hostname / ⚠️ Test')
  })
})
