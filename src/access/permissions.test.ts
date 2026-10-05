import { describe, expect, it } from 'vitest'

import {
  can,
  canWithOverrides,
  effectivePermissions,
  getOrgIdsWithPermission,
  minRoleFor,
  normalizePermissionOverrides,
  PERMISSIONS,
  type UserLike,
} from './permissions'

const member: UserLike = { id: 1, organizations: [{ organization: 10, role: 'member' }] }
const admin: UserLike = { id: 2, organizations: [{ organization: 10, role: 'admin' }] }
const owner: UserLike = { id: 3, organizations: [{ organization: 10, role: 'owner' }] }
const superadmin: UserLike = { id: 4, superadmin: true, organizations: [] }

describe('permission overrides', () => {
  it('normalises raw JSON to a minimal, valid diff', () => {
    expect(
      normalizePermissionOverrides({
        'monitor:create': 'admin', // raised
        'notification:create': 'member', // lowered
        'monitor:read': 'viewer', // equals the default → dropped
        'organization:delete': 'viewer', // locked → dropped
        'nope:thing': 'admin', // unknown permission → dropped
        'monitor:update': 'superuser', // unknown role → dropped
      }),
    ).toEqual({ 'monitor:create': 'admin', 'notification:create': 'member' })
    expect(normalizePermissionOverrides(null)).toEqual({})
    expect(normalizePermissionOverrides(['monitor:create'])).toEqual({})
    expect(normalizePermissionOverrides('monitor:create')).toEqual({})
  })

  it('resolves the effective minimum role per permission', () => {
    const overrides = { 'monitor:create': 'admin' as const }
    expect(minRoleFor('monitor:create', overrides)).toBe('admin')
    expect(minRoleFor('monitor:update', overrides)).toBe(PERMISSIONS['monitor:update'])
    expect(minRoleFor('organization:delete', { 'organization:delete': 'viewer' })).toBe('owner')
    const effective = effectivePermissions(overrides)
    expect(effective['monitor:create']).toBe('admin')
    expect(Object.keys(effective)).toEqual(Object.keys(PERMISSIONS))
  })

  it('canWithOverrides raises and lowers the bar while can() keeps the defaults', () => {
    const org = {
      id: 10,
      permissionOverrides: { 'monitor:create': 'admin', 'notification:create': 'member' },
    }

    expect(can(member, 10, 'monitor:create')).toBe(true)
    expect(canWithOverrides(member, org, 'monitor:create')).toBe(false)
    expect(canWithOverrides(admin, org, 'monitor:create')).toBe(true)

    expect(can(member, 10, 'notification:create')).toBe(false)
    expect(canWithOverrides(member, org, 'notification:create')).toBe(true)

    // Untouched permissions and locked ones behave as before.
    expect(canWithOverrides(member, org, 'monitor:update')).toBe(true)
    expect(
      canWithOverrides(
        admin,
        { id: 10, permissionOverrides: { 'organization:delete': 'admin' } },
        'organization:delete',
      ),
    ).toBe(false)
    expect(canWithOverrides(owner, org, 'organization:delete')).toBe(true)

    // Superadmins and non-members are unaffected.
    expect(canWithOverrides(superadmin, org, 'monitor:create')).toBe(true)
    expect(canWithOverrides(member, { id: 11, permissionOverrides: {} }, 'monitor:read')).toBe(
      false,
    )
    expect(
      canWithOverrides(member, { id: 10, permissionOverrides: 'garbage' }, 'monitor:create'),
    ).toBe(true)
  })

  it('getOrgIdsWithPermission applies per-organization overrides', () => {
    const user: UserLike = {
      id: 5,
      organizations: [
        { organization: 10, role: 'member' },
        { organization: 11, role: 'member' },
        { organization: 12, role: 'viewer' },
      ],
    }
    expect(getOrgIdsWithPermission(user, 'monitor:create')).toEqual([10, 11])
    expect(
      getOrgIdsWithPermission(user, 'monitor:create', {
        '10': { 'monitor:create': 'admin' },
        '12': { 'monitor:create': 'viewer' },
      }),
    ).toEqual([11, 12])
  })
})
