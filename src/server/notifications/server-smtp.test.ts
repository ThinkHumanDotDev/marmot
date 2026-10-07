import { describe, expect, it } from 'vitest'

import { canUseServerSmtp, checkServerSmtpChange, countSmtpRecipients } from './server-smtp'

describe('countSmtpRecipients', () => {
  it('counts addresses across to, cc and bcc, including display names with commas', () => {
    expect(
      countSmtpRecipients({
        to: '"Doe, Jane" <jane@example.com>, ops@example.com',
        cc: 'a@example.com; b@example.com',
        bcc: '',
      }),
    ).toBe(4)
    expect(countSmtpRecipients({ to: '  ' })).toBe(0)
  })
})

describe('checkServerSmtpChange', () => {
  const admin = { id: 1, superadmin: false }
  const root = { id: 2, superadmin: true }
  const server = { useServerSmtp: true, to: 'ops@example.com' }

  it('applies the policy per mode', () => {
    expect(canUseServerSmtp(admin, 'all')).toBe(true)
    expect(canUseServerSmtp(admin, 'superadmin')).toBe(false)
    expect(canUseServerSmtp(root, 'superadmin')).toBe(true)
    expect(canUseServerSmtp(root, 'off')).toBe(false)

    const create = { operation: 'create' as const, type: 'smtp', config: server }
    expect(checkServerSmtpChange({ ...create, user: admin, policy: 'superadmin' })).toMatchObject({
      status: 403,
    })
    expect(checkServerSmtpChange({ ...create, user: root, policy: 'superadmin' })).toBeNull()
    expect(
      checkServerSmtpChange({ ...create, user: null, overrideAccess: true, policy: 'superadmin' }),
    ).toBeNull()
    expect(
      checkServerSmtpChange({ ...create, user: null, overrideAccess: true, policy: 'off' }),
    ).toMatchObject({ status: 403 })
    expect(checkServerSmtpChange({ ...create, user: admin, policy: 'all' })).toBeNull()
  })

  it('leaves unchanged existing channels and other providers alone', () => {
    const update = {
      operation: 'update' as const,
      type: 'smtp',
      originalType: 'smtp',
      originalConfig: { ...server, cc: '' },
      user: admin,
      policy: 'off' as const,
    }
    expect(checkServerSmtpChange({ ...update, config: server })).toBeNull()
    expect(
      checkServerSmtpChange({ ...update, config: { ...server, to: 'x@example.com' } }),
    ).toMatchObject({ status: 403 })
    expect(
      checkServerSmtpChange({ ...update, config: { ...server, useServerSmtp: false } }),
    ).toBeNull()
    expect(
      checkServerSmtpChange({
        ...update,
        type: 'discord',
        originalType: 'discord',
        config: server,
      }),
    ).toBeNull()
  })
})
