import { describe, expect, it } from 'vitest'

import { loadEnv } from '@/env'

import {
  checkGroupAccess,
  desiredRoles,
  extractGroups,
  orgKey,
  parseGroupList,
  roleMappingSchema,
} from './sso-groups'

describe('identity-provider groups', () => {
  it('parses comma-separated allow-lists case-insensitively', () => {
    expect(parseGroupList(' Marmot-Users, sre,,SRE ')).toEqual(['marmot-users', 'sre'])
    expect(parseGroupList('')).toEqual([])
    expect(parseGroupList(undefined)).toEqual([])
  })

  it('reads list, string and nested claims, and tells a missing claim from an empty one', () => {
    expect(extractGroups({ groups: ['SRE', 'Ops ', 7] }, 'groups')).toEqual(['sre', 'ops', '7'])
    expect(extractGroups({ groups: 'a, B' }, 'groups')).toEqual(['a', 'b'])
    expect(extractGroups({ groups: [] }, 'groups')).toEqual([])
    expect(extractGroups({ email: 'x@y.z' }, 'groups')).toBeNull()
    expect(extractGroups({ groups: null }, 'groups')).toBeNull()
    expect(
      extractGroups({ realm_access: { roles: ['Marmot-Users'] } }, 'realm_access.roles'),
    ).toEqual(['marmot-users'])
    // A key that literally contains dots (SAML attribute URIs) wins over the nested path.
    const uri = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'
    expect(extractGroups({ [uri]: ['abc-123'] }, uri)).toEqual(['abc-123'])
    expect(extractGroups({ groups: [{ name: 'x' }] }, 'groups')).toEqual([])
  })

  it('allows everyone without an allow-list and refuses missing or foreign groups with one', () => {
    expect(checkGroupAccess([], null)).toEqual({ ok: true })
    expect(checkGroupAccess(['sre'], ['ops', 'sre'])).toEqual({ ok: true })
    expect(checkGroupAccess(['sre'], ['ops'])).toEqual({ ok: false, code: 'group_not_allowed' })
    expect(checkGroupAccess(['sre'], [])).toEqual({ ok: false, code: 'group_not_allowed' })
    expect(checkGroupAccess(['sre'], null)).toEqual({ ok: false, code: 'groups_missing' })
  })

  it('validates OIDC_ROLE_MAPPING and normalises it into rules', () => {
    const parsed = roleMappingSchema.parse(
      JSON.stringify({
        'Platform-Admins': { org: 'Acme', role: 'admin' },
        sre: [
          { org: 'acme', role: 'member' },
          { org: 'ops', role: 'viewer' },
        ],
        'marmot-admins': { role: 'superadmin' },
      }),
    )
    expect(parsed).toEqual([
      { group: 'platform-admins', org: { slug: 'acme' }, role: 'admin' },
      { group: 'sre', org: { slug: 'acme' }, role: 'member' },
      { group: 'sre', org: { slug: 'ops' }, role: 'viewer' },
      { group: 'marmot-admins', superadmin: true },
    ])
    expect(roleMappingSchema.parse('')).toEqual([])
    expect(roleMappingSchema.safeParse('{nope').success).toBe(false)
    expect(roleMappingSchema.safeParse('{"g": {"org": "acme", "role": "god"}}').success).toBe(false)
    expect(roleMappingSchema.safeParse('{"g": {"role": "admin"}}').success).toBe(false)
    expect(
      roleMappingSchema.safeParse('{"g": {"org": "a", "role": "admin", "x": 1}}').success,
    ).toBe(false)
  })

  it('fails startup on an invalid mapping', () => {
    const base = {
      NODE_ENV: 'test',
      PAYLOAD_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgres://x',
    } as NodeJS.ProcessEnv
    expect(() => loadEnv({ ...base, OIDC_ROLE_MAPPING: '[1]' })).toThrow(/OIDC_ROLE_MAPPING/)
    expect(loadEnv({ ...base }).OIDC_ROLE_MAPPING).toEqual([])
    expect(loadEnv({ ...base }).OIDC_GROUP_CLAIM).toBe('groups')
  })

  it('picks the highest role per organization and reports the managed ones', () => {
    const rules = roleMappingSchema.parse(
      JSON.stringify({
        sre: { org: 'acme', role: 'member' },
        'platform-admins': { org: 'acme', role: 'admin' },
        ops: { org: 'ops', role: 'viewer' },
        root: { role: 'superadmin' },
      }),
    )
    const both = desiredRoles(rules, ['sre', 'platform-admins'])
    expect(both.roles.get(orgKey({ slug: 'acme' }))).toBe('admin')
    expect(both.roles.has(orgKey({ slug: 'ops' }))).toBe(false)
    expect([...both.managed].sort()).toEqual(['slug:acme', 'slug:ops'])
    expect(both.superadmin).toBe(false)
    expect(desiredRoles(rules, ['root']).superadmin).toBe(true)
    expect(desiredRoles(rules.slice(0, 2), ['root']).superadmin).toBeNull()
  })
})
