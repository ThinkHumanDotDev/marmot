import { describe, expect, it } from 'vitest'

import { findPlaceholders, renderPlaceholders } from './placeholders'
import {
  fillPlaceholder,
  renderTemplateText,
  templateImpacts,
  templatesFor,
  toTemplateRow,
  type TemplateRow,
} from './templates'

const row = (overrides: Partial<TemplateRow>): TemplateRow => ({
  id: '1',
  name: 'T',
  kind: 'incident',
  title: '',
  body: '',
  status: null,
  impact: null,
  statusPage: null,
  components: [],
  duration: null,
  ...overrides,
})

describe('renderPlaceholders', () => {
  it('replaces resolved paths and keeps unresolved ones as written', () => {
    const out = renderPlaceholders('{{ a }} {{b.c}} {{ missing }}', (path) =>
      path === 'a' ? 'A' : path === 'b.c' ? 'C' : undefined,
    )
    expect(out).toBe('A C {{ missing }}')
  })

  it('never evaluates anything that is not a dotted identifier', () => {
    const resolve = () => 'X'
    expect(renderPlaceholders('{{ 1 + 1 }} {{ a() }} {{ constructor }}', resolve)).toBe(
      '{{ 1 + 1 }} {{ a() }} X',
    )
  })
})

describe('findPlaceholders', () => {
  it('lists distinct placeholders across texts in order of appearance', () => {
    expect(findPlaceholders('Fix by {{ eta }}', null, '{{eta}} on {{ page }}')).toEqual([
      'eta',
      'page',
    ])
  })

  it('ignores Markdown code spans and fenced blocks', () => {
    const text = 'Use `{{ monitor.name }}` in templates.\n```\n{{ eta }}\n```\nDone.'
    expect(findPlaceholders(text)).toEqual([])
    expect(findPlaceholders('`{{ a }}` but {{ b }}')).toEqual(['b'])
  })
})

describe('renderTemplateText', () => {
  it('fills only the variables of the kind that have a value', () => {
    const text = '{{ page }}: {{ components }} degraded, next update {{ eta }} ({{ incident }})'
    expect(
      renderTemplateText(text, 'incident', {
        page: 'Acme status',
        components: 'API and Website',
        incident: 'not for new incidents',
      }),
    ).toBe('Acme status: API and Website degraded, next update {{ eta }} ({{ incident }})')
  })

  it('leaves empty variables for the author', () => {
    expect(
      renderTemplateText('From {{ start }} for {{ duration }}', 'maintenance', {
        start: '',
        duration: '2 hours',
      }),
    ).toBe('From {{ start }} for 2 hours')
  })
})

describe('templateImpacts and templatesFor', () => {
  it('keeps only components the page has', () => {
    const template = row({
      components: [
        { component: 'a', impact: 'major_outage' },
        { component: 'gone', impact: 'partial_outage' },
      ],
    })
    expect(templateImpacts(template, ['a', 'b'])).toEqual({ a: 'major_outage' })
  })

  it('offers the page’s own and organization-wide templates of the kind', () => {
    const all = [
      row({ id: '1', statusPage: null }),
      row({ id: '2', statusPage: '7' }),
      row({ id: '3', statusPage: '8' }),
      row({ id: '4', kind: 'maintenance' }),
    ]
    expect(templatesFor(all, 'incident', 7).map((t) => t.id)).toEqual(['1', '2'])
    expect(templatesFor(all, 'maintenance').map((t) => t.id)).toEqual(['4'])
  })
})

describe('fillPlaceholder and toTemplateRow', () => {
  it('fills every occurrence of one placeholder', () => {
    expect(fillPlaceholder('{{ eta }} / {{eta}} / {{ x }}', 'eta', '14:00')).toBe(
      '14:00 / 14:00 / {{ x }}',
    )
  })

  it('normalises documents of either adapter', () => {
    expect(
      toTemplateRow({
        id: 5,
        name: 'DB',
        kind: 'bogus',
        statusPage: { id: 9 },
        status: 'identified',
        impact: 'nope',
        components: [{ component: 'r1', impact: 'major_outage' }, { component: 3 }],
        duration: 0,
      }),
    ).toEqual({
      id: '5',
      name: 'DB',
      kind: 'incident',
      title: '',
      body: '',
      status: 'identified',
      impact: null,
      statusPage: '9',
      components: [{ component: 'r1', impact: 'major_outage' }],
      duration: null,
    })
  })
})
