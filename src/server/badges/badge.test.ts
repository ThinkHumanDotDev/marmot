import { describe, expect, it } from 'vitest'

import {
  badgeConstants,
  badgeParamsFromSearch,
  buildBadge,
  filterAndJoin,
  parseBadgeDuration,
  percentageToColor,
  renderBadge,
} from './badge'

const params = (query: string) => badgeParamsFromSearch(new URLSearchParams(query))

describe('badge builder', () => {
  describe('status', () => {
    it.each([
      ['up', 'Up', badgeConstants.defaultUpColor],
      ['down', 'Down', badgeConstants.defaultDownColor],
      ['pending', 'Pending', badgeConstants.defaultPendingColor],
      ['maintenance', 'Maintenance', badgeConstants.defaultMaintenanceColor],
      ['degraded', 'Degraded', badgeConstants.defaultWarnColor],
    ] as const)('renders %s with the default label and colour', (status, message, color) => {
      expect(buildBadge('status', { status }, {})).toEqual({
        style: 'flat',
        label: 'Status',
        message,
        color,
      })
    })

    it('honours custom labels, colours and style', () => {
      const format = buildBadge(
        'status',
        { status: 'down' },
        params('label=API&downLabel=Offline&downColor=red&style=for-the-badge'),
      )
      expect(format).toEqual({
        style: 'for-the-badge',
        label: 'API',
        message: 'Offline',
        color: 'red',
      })
    })

    it('falls back to N/A without a status and to flat for unknown styles', () => {
      const format = buildBadge('status', {}, params('style=nope'))
      expect(format.message).toBe('N/A')
      expect(format.color).toBe(badgeConstants.naColor)
      expect(format.style).toBe('flat')
    })
  })

  describe('uptime', () => {
    it('formats the ratio to four significant digits with a window label', () => {
      const format = buildBadge('uptime', { uptime: 0.99987, range: '24h' }, {})
      expect(format.label).toBe('Uptime (24h)')
      expect(format.message).toBe('99.99%')
      expect(format.labelColor).toBe('')
      expect(format.color).toBe(percentageToColor(0.99987))
    })

    it('uses the right unit for 30d and 1y windows', () => {
      expect(buildBadge('uptime', { uptime: 1, range: '30d' }, {}).label).toBe('Uptime (30d)')
      expect(buildBadge('uptime', { uptime: 1, range: '1y' }, {}).label).toBe('Uptime (1y)')
    })

    it('applies prefix/suffix/labelPrefix/labelSuffix and explicit colours', () => {
      const format = buildBadge(
        'uptime',
        { uptime: 0.5, range: '24h' },
        params(
          'labelPrefix=[prod] &labelSuffix=hrs&prefix=~&suffix= pct&color=purple&labelColor=black',
        ),
      )
      expect(format).toEqual({
        style: 'flat',
        color: 'purple',
        labelColor: 'black',
        label: '[prod] Uptime (24hrs)',
        message: '~50.00 pct',
      })
    })

    it('is N/A without data', () => {
      expect(buildBadge('uptime', { range: '24h' }, {}).message).toBe('N/A')
    })
  })

  describe('ping and avg-response', () => {
    it('ping: integer milliseconds with default suffix and window', () => {
      const format = buildBadge('ping', { avgPing: 123.7, range: '24h' }, {})
      expect(format).toEqual({
        style: 'flat',
        color: 'blue',
        labelColor: '',
        label: 'Avg. Ping (24h)',
        message: '123ms',
      })
    })

    it('avg-response: Kuma label with labelSuffix appended after the window', () => {
      const format = buildBadge(
        'avg-response',
        { avgPing: 42, range: '30d' },
        params('labelSuffix= (p50)&suffix= ms&color=green'),
      )
      expect(format.label).toBe('Avg. Response (30d) (p50)')
      expect(format.message).toBe('42 ms')
      expect(format.color).toBe('green')
    })

    it('N/A without an average', () => {
      expect(buildBadge('ping', { range: '24h' }, {}).message).toBe('N/A')
      expect(buildBadge('avg-response', { avgPing: null }, {}).message).toBe('N/A')
    })
  })

  describe('response', () => {
    it('shows the last ping', () => {
      expect(buildBadge('response', { lastPing: 87.9 }, params('label=Latency'))).toEqual({
        style: 'flat',
        color: 'blue',
        labelColor: '',
        label: 'Latency',
        message: '87ms',
      })
    })

    it('N/A when the last beat had no ping', () => {
      expect(buildBadge('response', { lastPing: null }, {}).message).toBe('N/A')
      expect(buildBadge('response', { lastPing: 0 }, {}).message).toBe('N/A')
    })
  })

  describe('cert-exp', () => {
    const cert = (daysRemaining: number, valid = true) => ({
      valid,
      daysRemaining,
      validTo: '2030-01-01T00:00:00.000Z',
    })

    it('is green above warnDays, yellow above downDays, red below', () => {
      expect(buildBadge('cert-exp', { cert: cert(30) }, {}).color).toBe(
        badgeConstants.defaultUpColor,
      )
      expect(buildBadge('cert-exp', { cert: cert(10) }, {}).color).toBe(
        badgeConstants.defaultWarnColor,
      )
      expect(buildBadge('cert-exp', { cert: cert(3) }, {}).color).toBe(
        badgeConstants.defaultDownColor,
      )
    })

    it('honours warnDays / downDays and shows the date on demand', () => {
      const custom = buildBadge('cert-exp', { cert: cert(40) }, params('warnDays=60&downDays=45'))
      expect(custom.color).toBe(badgeConstants.defaultDownColor)
      expect(custom.message).toBe('40 days')
      const dated = buildBadge('cert-exp', { cert: cert(40) }, params('date=1'))
      expect(dated.message).toBe('2030-01-01T00:00:00.000Z')
      expect(dated.label).toBe('Cert Exp.')
    })

    it('reports missing and invalid certificates', () => {
      expect(buildBadge('cert-exp', { cert: null }, {})).toMatchObject({
        message: 'No/Bad Cert',
        color: badgeConstants.naColor,
      })
      expect(buildBadge('cert-exp', { cert: cert(5, false) }, params('downColor=black'))).toEqual({
        style: 'flat',
        message: 'Bad Cert',
        color: 'black',
      })
    })
  })

  describe('helpers', () => {
    it('parseBadgeDuration accepts Kuma spellings and hour counts', () => {
      expect(parseBadgeDuration(undefined)).toBe('24h')
      expect(parseBadgeDuration('24')).toBe('24h')
      expect(parseBadgeDuration('30d')).toBe('30d')
      expect(parseBadgeDuration('720')).toBe('30d')
      expect(parseBadgeDuration('1y')).toBe('1y')
      expect(parseBadgeDuration('8760h')).toBe('1y')
      expect(parseBadgeDuration('7d')).toBeNull()
      expect(parseBadgeDuration('abc')).toBeNull()
    })

    it('percentageToColor spans red to green', () => {
      expect(percentageToColor(1)).toBe('#66c20a')
      expect(percentageToColor(0)).toBe('#c2290a')
      expect(percentageToColor(Number.NaN)).toBe(badgeConstants.naColor)
    })

    it('filterAndJoin drops empty parts', () => {
      expect(filterAndJoin(['a', '', undefined, null, 1, 'b'], '-')).toBe('a-1-b')
    })

    it('badgeParamsFromSearch only picks known keys', () => {
      expect(params('label=x&evil=1&style=flat-square')).toEqual({
        label: 'x',
        style: 'flat-square',
      })
    })
  })

  describe('renderBadge', () => {
    it('produces an SVG with both texts', () => {
      const svg = renderBadge(buildBadge('status', { status: 'up' }, {}))
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).toContain('Status')
      expect(svg).toContain('Up')
    })

    it('escapes user-controlled text', () => {
      const svg = renderBadge(
        buildBadge('status', { status: 'up' }, params('label=<script>alert(1)</script>')),
      )
      expect(svg).not.toContain('<script>')
      expect(svg).toContain('&lt;script&gt;')
    })

    it('never throws on garbage colours', () => {
      const svg = renderBadge(buildBadge('status', { status: 'up' }, params('upColor=not a color')))
      expect(svg.startsWith('<svg')).toBe(true)
    })
  })
})
