import { describe, expect, it } from 'vitest'

import { cn, initials, safeNextPath } from './utils'

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, null, 'c')).toBe('a c')
  })

  it('resolves conflicting Tailwind utilities, last one wins', () => {
    expect(cn('p-2 text-sm', 'p-4')).toBe('text-sm p-4')
    expect(cn('bg-background', 'bg-card')).toBe('bg-card')
  })

  it('accepts objects and arrays', () => {
    expect(cn(['flex', { hidden: false, 'items-center': true }])).toBe('flex items-center')
  })
})

describe('initials', () => {
  it('uses first and last name', () => {
    expect(initials('Jane Doe')).toBe('JD')
    expect(initials('jane')).toBe('J')
  })

  it('falls back to the email local part', () => {
    expect(initials('jane.doe@example.com')).toBe('JD')
    expect(initials('ops@example.com')).toBe('O')
  })

  it('handles empty input', () => {
    expect(initials(undefined)).toBe('?')
    expect(initials('   ')).toBe('?')
  })
})

describe('safeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/acme/monitors')).toBe('/acme/monitors')
  })

  it('falls back to / for missing or external destinations', () => {
    expect(safeNextPath(undefined)).toBe('/')
    expect(safeNextPath('')).toBe('/')
    expect(safeNextPath('https://evil.example')).toBe('/')
    expect(safeNextPath('//evil.example')).toBe('/')
    expect(safeNextPath('/\\evil.example')).toBe('/')
  })
})
