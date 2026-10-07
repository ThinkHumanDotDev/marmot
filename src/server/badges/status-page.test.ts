import { describe, expect, it } from 'vitest'

import { badgeConstants } from './badge'
import {
  approximateTextWidth,
  renderStatusPageBadge,
  statusPageBadgeFormat,
  statusPageBadgeOptions,
  STATUS_PAGE_BADGE_MESSAGES,
  STATUS_PAGE_BADGE_STATES,
} from './status-page'

const options = (query: string) => statusPageBadgeOptions(new URLSearchParams(query))

describe('status page badge', () => {
  describe('options', () => {
    it('defaults to a light, medium, filled pill', () => {
      expect(options('')).toEqual({
        theme: 'light',
        size: 'md',
        variant: 'default',
        style: null,
        label: null,
      })
    })

    it('reads every option and falls back on unknown values', () => {
      expect(options('theme=dark&size=xl&variant=outline&style=for-the-badge&label=API')).toEqual({
        theme: 'dark',
        size: 'xl',
        variant: 'outline',
        style: 'for-the-badge',
        label: 'API',
      })
      expect(options('theme=pink&size=huge&variant=x&style=nope')).toMatchObject({
        theme: 'light',
        size: 'md',
        variant: 'default',
        style: 'flat',
      })
    })

    it('caps the label length', () => {
      expect(options(`label=${'a'.repeat(500)}`).label).toHaveLength(64)
    })
  })

  describe('shields renderer (style=)', () => {
    it.each([
      ['operational', 'All systems operational', badgeConstants.defaultUpColor],
      ['degraded', 'Degraded performance', badgeConstants.defaultWarnColor],
      ['partial', 'Partial outage', badgeConstants.defaultPendingColor],
      ['major', 'Major outage', badgeConstants.defaultDownColor],
      ['maintenance', 'Under maintenance', badgeConstants.defaultMaintenanceColor],
      ['unknown', 'Unknown', badgeConstants.naColor],
    ] as const)('%s → "%s" in the monitor badge colour', (state, message, color) => {
      expect(statusPageBadgeFormat(state, { style: 'flat', label: null })).toEqual({
        style: 'flat',
        label: 'Status',
        message,
        color,
      })
      const svg = renderStatusPageBadge(state, { ...options('style=flat') })
      expect(svg).toContain(message)
      expect(svg).toContain(color)
    })

    it('honours the label override and style', () => {
      const svg = renderStatusPageBadge('major', options('style=flat-square&label=Acme'))
      expect(svg).toContain('Acme')
      expect(svg).toContain('Major outage')
      expect(svg).not.toContain('>Status<')
    })
  })

  describe('pill renderer', () => {
    it.each(STATUS_PAGE_BADGE_STATES)('renders %s with its message and colour', (state) => {
      const svg = renderStatusPageBadge(state, options(''))
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).toContain(`data-state="${state}"`)
      expect(svg).toContain(`>${STATUS_PAGE_BADGE_MESSAGES[state]}</text>`)
      expect(svg).toContain(`<title>${STATUS_PAGE_BADGE_MESSAGES[state]}</title>`)
    })

    it('switches the palette with the theme', () => {
      expect(renderStatusPageBadge('operational', options('theme=light'))).toContain('#ffffff')
      const dark = renderStatusPageBadge('operational', options('theme=dark'))
      expect(dark).toContain('#18181b')
      expect(dark).toContain('#fafafa')
    })

    it('draws a status-coloured border without fill for the outline variant', () => {
      const svg = renderStatusPageBadge('major', options('variant=outline'))
      expect(svg).toContain(`fill="none" stroke="${badgeConstants.defaultDownColor}"`)
    })

    it('grows with the size', () => {
      const heights = (['sm', 'md', 'lg', 'xl'] as const).map((size) => {
        const svg = renderStatusPageBadge('operational', options(`size=${size}`))
        return Number(/height="(\d+)"/.exec(svg)?.[1])
      })
      expect(heights).toEqual([20, 24, 32, 40])
    })

    it('prefixes the escaped label', () => {
      const svg = renderStatusPageBadge(
        'partial',
        options(`label=${encodeURIComponent('<Acme & Co>')}`),
      )
      expect(svg).toContain('&lt;Acme &amp; Co&gt;')
      expect(svg).toContain('<title>&lt;Acme &amp; Co&gt;: Partial outage</title>')
      expect(svg).not.toContain('<Acme')
    })
  })

  it('estimates wider text for longer strings', () => {
    expect(approximateTextWidth('All systems operational', 12)).toBeGreaterThan(
      approximateTextWidth('Unknown', 12),
    )
    const small = approximateTextWidth('Unknown', 12)
    expect(Math.abs(approximateTextWidth('Unknown', 24) - small * 2)).toBeLessThanOrEqual(1)
  })
})
