import { describe, expect, it } from 'vitest'

import {
  buildThemeCss,
  contrastRatio,
  DEFAULT_THEME_PRESET,
  isValidColor,
  parseThemeOverrides,
  resolveThemeColors,
  THEME_COLOR_TOKENS,
  THEME_MODES,
  THEME_PRESETS,
  toHex,
} from '.'

describe('colour validation', () => {
  it.each([
    '#fff',
    '#FFFA',
    '#0b5cad',
    '#0b5cad80',
    'rgb(12 34 56)',
    'rgb(12, 34, 56)',
    'rgba(12, 34, 56, 0.5)',
    'rgb(10% 20% 30% / 50%)',
    'hsl(210 50% 40%)',
    'hsl(210deg, 50%, 40%)',
    'hsla(210, 50%, 40%, .4)',
    'oklch(0.56 0.18 40)',
    'oklch(56% 0.18 40deg / 0.9)',
    '  #ABCDEF  ',
  ])('accepts %s', (value) => {
    expect(isValidColor(value)).toBe(true)
  })

  it.each([
    '',
    'red',
    'transparent',
    '#ggg',
    '#12345',
    'rgb(256 0 0)',
    'rgb(0 0 0 / 2)',
    'hsl(10 120% 50%)',
    'oklch(2 0.1 10)',
    'var(--primary)',
    'calc(1px)',
    'url(https://evil.test/x)',
    '#fff;background:url(x)',
    '#fff}body{display:none',
    'rgb(1 2 3);}</style><script>alert(1)</script>',
    'rgb(1, 2 3)',
    'oklch(0.5 0.1 10) /* */',
    'expression(alert(1))',
    `#${'f'.repeat(100)}`,
    42,
    null,
  ])('rejects %s', (value) => {
    expect(isValidColor(value)).toBe(false)
  })

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
    expect(contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)')).toBeCloseTo(21, 0)
    expect(contrastRatio('nope', '#fff')).toBeNull()
  })

  it('converts to hex for colour pickers', () => {
    expect(toHex('#abc')).toBe('#aabbcc')
    expect(toHex('rgb(255 0 0)')).toBe('#ff0000')
    expect(toHex('hsl(120 100% 25%)')).toBe('#008000')
    expect(toHex('oklch(1 0 0)')).toBe('#ffffff')
  })
})

describe('parseThemeOverrides', () => {
  it('normalises and drops empty values', () => {
    const result = parseThemeOverrides({
      light: { primary: ' #0B5CAD ', destructive: '' },
      dark: { primary: 'OKLCH(0.7  0.1 40)', destructive: null },
      radius: '0.5REM',
    })
    expect(result).toEqual({
      ok: true,
      value: {
        light: { primary: '#0b5cad' },
        dark: { primary: 'oklch(0.7 0.1 40)' },
        radius: '0.5rem',
      },
    })
  })

  it('returns null when nothing is overridden', () => {
    expect(parseThemeOverrides(null)).toEqual({ ok: true, value: null })
    expect(parseThemeOverrides({ light: {}, dark: { primary: '' }, radius: '' })).toEqual({
      ok: true,
      value: null,
    })
  })

  it('rejects invalid colours, unknown tokens and bad shapes', () => {
    const result = parseThemeOverrides({
      light: { primary: 'red;}', '--background': '#fff', destructive: 12 },
      dark: 'nope',
      sepia: {},
      radius: '10vw',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { path: 'light.primary', code: 'invalidColor' },
        { path: 'light.--background', code: 'unknownKey' },
        { path: 'light.destructive', code: 'invalidColor' },
        { path: 'dark', code: 'shape' },
        { path: 'sepia', code: 'unknownKey' },
        { path: 'radius', code: 'invalidRadius' },
      ]),
    )
    expect(parseThemeOverrides([]).ok).toBe(false)
    expect(parseThemeOverrides('#fff').ok).toBe(false)
  })

  it('bounds the radius', () => {
    expect(parseThemeOverrides({ radius: '0' }).ok).toBe(true)
    expect(parseThemeOverrides({ radius: '32px' }).ok).toBe(true)
    expect(parseThemeOverrides({ radius: '33px' }).ok).toBe(false)
    expect(parseThemeOverrides({ radius: '2.5rem' }).ok).toBe(false)
    expect(parseThemeOverrides({ radius: '-1rem' }).ok).toBe(false)
  })
})

describe('buildThemeCss', () => {
  it('emits nothing for the default preset without overrides (existing pages unchanged)', () => {
    expect(buildThemeCss(null, null)).toBe('')
    expect(buildThemeCss(DEFAULT_THEME_PRESET, {})).toBe('')
  })

  it('scopes light and dark overrides to their mode', () => {
    const css = buildThemeCss('default', {
      dark: { primary: '#ff8800', destructive: '#ff0000' },
    })
    expect(css).toBe(
      'html.dark{--primary:#ff8800;--ring:#ff8800;--status-down:#ff0000;--status-down-text:#ff0000;--destructive:#ff0000}',
    )
  })

  it('writes every preset token and lets overrides win', () => {
    const css = buildThemeCss('ocean', { light: { primary: '#123456' }, radius: '4px' })
    expect(css).toContain('html:not(.dark){--background:#f7fafc')
    expect(css).toContain('--primary:#123456')
    expect(css).toContain('html.dark{--background:#0b1622')
    expect(css).toContain('html:root{--radius:4px}')
  })

  it('drops values that bypassed validation', () => {
    const css = buildThemeCss('default', {
      light: { primary: '#fff;}</style><script>alert(1)</script>', bogus: '#fff' } as never,
      radius: '1rem;}x{' as never,
    })
    expect(css).toBe('')
  })

  it('falls back to the default preset for unknown ids', () => {
    expect(buildThemeCss('does-not-exist', null)).toBe('')
  })
})

describe('presets', () => {
  it('have unique ids and define every token in both modes', () => {
    expect(new Set(THEME_PRESETS.map((p) => p.id)).size).toBe(THEME_PRESETS.length)
    expect(THEME_PRESETS[0].id).toBe(DEFAULT_THEME_PRESET)
    for (const preset of THEME_PRESETS) {
      for (const mode of THEME_MODES) {
        for (const token of THEME_COLOR_TOKENS) {
          expect(isValidColor(preset[mode][token]), `${preset.id}.${mode}.${token}`).toBe(true)
        }
      }
      expect(parseThemeOverrides({ radius: preset.radius }).ok, `${preset.id}.radius`).toBe(true)
    }
  })

  // Text pairs need WCAG AA (4.5:1). Status tokens also drive the `--status-*-text` variables, so
  // they need 4.5:1 against both surfaces as well. High contrast goes further: AAA (7:1) for text.
  // The default preset is the existing stylesheet, which keeps separate fill/text status colours
  // (its amber fill cannot reach 3:1 on white), so its status colours are not checked here.
  for (const preset of THEME_PRESETS) {
    for (const mode of THEME_MODES) {
      it(`${preset.id} (${mode}) meets contrast targets`, () => {
        const c = resolveThemeColors(preset.id, null, mode)
        const text = preset.id === 'high-contrast' ? 7 : 4.5
        const ratio = (a: string, b: string) => contrastRatio(a, b) ?? 0

        for (const surface of [c.background, c.card]) {
          expect(ratio(c.foreground, surface), 'foreground').toBeGreaterThanOrEqual(text)
          expect(ratio(c.mutedForeground, surface), 'mutedForeground').toBeGreaterThanOrEqual(4.5)
          if (preset.id === DEFAULT_THEME_PRESET) continue
          for (const token of ['success', 'warning', 'info', 'destructive'] as const) {
            expect(ratio(c[token], surface), token).toBeGreaterThanOrEqual(4.5)
          }
        }
        expect(ratio(c.foreground, c.muted), 'foreground on muted').toBeGreaterThanOrEqual(4.5)
        expect(ratio(c.primaryForeground, c.primary), 'primaryForeground').toBeGreaterThanOrEqual(
          4.5,
        )
        if (preset.id !== DEFAULT_THEME_PRESET) {
          expect(ratio(c.primary, c.background), 'primary on background').toBeGreaterThanOrEqual(3)
        }
      })
    }
  }
})
