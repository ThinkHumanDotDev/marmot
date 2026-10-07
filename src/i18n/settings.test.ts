import { describe, expect, it } from 'vitest'

import { PERMISSIONS, ROLES } from '@/access/permissions'
import { actionKey, resourceKey } from '@/components/settings/permission-labels'
import { getMessages } from '@/i18n/messages'
import { getStaticFormatter, getTranslator } from '@/i18n/translator'

const t = getTranslator('en')

describe('settings, members and notification channel messages (en)', () => {
  it('keeps the English plurals and role words the components used to build by hand', () => {
    expect(t('settings.account.twoFactor.enabledDescription', { count: 1 })).toBe(
      'Signing in requires a code from your authenticator app. 1 backup code left.',
    )
    expect(t('settings.account.twoFactor.enabledDescription', { count: 8 })).toMatch(
      /8 backup codes left\.$/,
    )
    expect(t('settings.account.delete.blocked', { organizations: 'Acme, Beta', count: 2 })).toBe(
      'You are the only owner of Acme, Beta. Transfer ownership or delete them first.',
    )
    expect(t('settings.dockerHosts.test.containers', { count: 1 })).toBe(
      '1 container on this host.',
    )
    expect(t('members.table.roleChanged', { member: 'Ada', role: 'admin' })).toBe(
      'Ada is now admin',
    )
    expect(t('invite.accept.joinAs', { role: 'viewer', email: 'a@example.com' })).toBe(
      'You will join as viewer, signed in as a@example.com.',
    )
    expect(t('settings.sso.connections.joinAs', { role: 'member' })).toBe('Join as member')
    expect(t('settings.apiKeys.lastUsed.minutes', { count: 5 })).toBe('5 min ago')
  })

  it('has a label and a description for every role', () => {
    const roles = getMessages('en').members.roles as Record<string, unknown>
    for (const role of ROLES) {
      expect(roles[role], role).toMatchObject({
        label: expect.any(String),
        description: expect.any(String),
      })
    }
  })

  it('labels every resource and action of the permission table', () => {
    const { resources, actions } = getMessages('en').settings.permissions
    for (const permission of Object.keys(PERMISSIONS)) {
      const [resource, action] = permission.split(':')
      const rKey = resourceKey(resource)
      const aKey = actionKey(action)
      expect(rKey, `resource of ${permission}`).not.toBeNull()
      expect(aKey, `action of ${permission}`).not.toBeNull()
      expect(resources[rKey as keyof typeof resources], permission).toEqual(expect.any(String))
      expect(actions[aKey as keyof typeof actions], permission).toEqual(expect.any(String))
    }
  })

  it('formats dates in the organization time zone', () => {
    const format = getStaticFormatter('en', 'Asia/Tokyo')
    // 23:30 UTC is already the next day in Tokyo.
    expect(format.dateTime(new Date('2026-10-06T23:30:00Z'), 'date')).toBe('Oct 7, 2026')
  })
})
