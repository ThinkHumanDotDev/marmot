import { describe, expect, it } from 'vitest'

import {
  defaultLocale,
  locales,
  matchLocale,
  parseAcceptLanguage,
  readCookie,
  resolveLocale,
} from './locales'

/** A hypothetical future locale list, so the resolution order is observable with one shipped language. */
const supported = ['en', 'fr', 'pt-BR'] as const

describe('parseAcceptLanguage', () => {
  it('orders tags by quality, keeping header order for ties', () => {
    expect(parseAcceptLanguage('fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5')).toEqual([
      'fr-CH',
      'fr',
      'en',
      'de',
    ])
    expect(parseAcceptLanguage('en;q=0.5, fr')).toEqual(['fr', 'en'])
  })

  it('drops wildcards, q=0 and malformed entries', () => {
    expect(parseAcceptLanguage('*')).toEqual([])
    expect(parseAcceptLanguage('de;q=0, en;q=abc, , fr')).toEqual(['fr'])
    expect(parseAcceptLanguage(null)).toEqual([])
  })
})

describe('matchLocale', () => {
  it('prefers an exact match, then the base language, ignoring case', () => {
    expect(matchLocale(['pt-br'], supported)).toBe('pt-BR')
    expect(matchLocale(['pt'], supported)).toBe('pt-BR')
    expect(matchLocale(['en-GB', 'fr'], supported)).toBe('en')
    expect(matchLocale(['FR-ca'], supported)).toBe('fr')
  })

  it('returns undefined when nothing is supported', () => {
    expect(matchLocale(['de', 'ja'], supported)).toBeUndefined()
    expect(matchLocale([], supported)).toBeUndefined()
  })
})

describe('resolveLocale', () => {
  it('uses the saved preference first', () => {
    expect(
      resolveLocale({ preference: 'fr', cookie: 'pt-BR', acceptLanguage: 'en' }, supported),
    ).toBe('fr')
  })

  it('falls back to the cookie, then Accept-Language, then the default', () => {
    expect(resolveLocale({ cookie: 'pt-BR', acceptLanguage: 'fr' }, supported)).toBe('pt-BR')
    expect(resolveLocale({ acceptLanguage: 'de, fr;q=0.8' }, supported)).toBe('fr')
    expect(resolveLocale({ acceptLanguage: 'de' }, supported)).toBe(defaultLocale)
    expect(resolveLocale({}, supported)).toBe(defaultLocale)
  })

  it('skips unsupported values instead of trusting them', () => {
    expect(resolveLocale({ preference: 'xx', cookie: 'yy', acceptLanguage: 'pt' }, supported)).toBe(
      'pt-BR',
    )
    expect(resolveLocale({ preference: 'FR' }, supported)).toBe(defaultLocale)
  })

  it('only ever returns a shipped locale with the real list', () => {
    for (const locale of [
      resolveLocale({ preference: 'fr', cookie: 'de', acceptLanguage: 'ja, fr;q=0.9' }),
      resolveLocale({}),
    ]) {
      expect(locales).toContain(locale)
    }
  })
})

describe('readCookie', () => {
  it('reads one cookie out of a Cookie header', () => {
    const header = 'payload-token=abc; marmot-locale=pt-BR; other=x%3Dy'
    expect(readCookie(header, 'marmot-locale')).toBe('pt-BR')
    expect(readCookie(header, 'other')).toBe('x=y')
    expect(readCookie(header, 'missing')).toBeUndefined()
    expect(readCookie(null, 'marmot-locale')).toBeUndefined()
  })
})
