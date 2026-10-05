import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import config from '@payload-config'

import { POST as setupRoute } from '@/app/api/setup/route'
import { GET as statusRoute } from '@/app/api/setup/status/route'
import { canSignUp } from '@/collections/Users'
import { env } from '@/env'
import { getUserRole } from '@/access/permissions'
import {
  defaultInstanceSettings,
  getInstanceSettings,
  isSignupAllowed,
  resetInstanceSettingsCache,
} from '@/server/settings'
import {
  createSetupSession,
  needsSetup,
  resetSetupCache,
  runSetup,
  SetupError,
  setupSchema,
} from '@/server/setup'

let payload: Payload

const run = Date.now().toString(36)

const input = {
  name: 'Ada Lovelace',
  email: `ada+${run}@marmot.test`,
  password: 'correct-horse-battery',
  organizationName: 'Analytical Engines',
  organizationSlug: `analytical-${run}`,
}

/** Back to a fresh install: no users, none of this run's organizations, cold setup cache. */
async function resetInstance(): Promise<void> {
  await payload.delete({ collection: 'users', where: { email: { exists: true } } })
  await payload.delete({ collection: 'organizations', where: { slug: { like: `-${run}` } } })
  resetSetupCache()
}

const countUsers = async () => (await payload.count({ collection: 'users' })).totalDocs
const countOrgs = async (slug: string) =>
  (await payload.count({ collection: 'organizations', where: { slug: { equals: slug } } }))
    .totalDocs

describe('first-run setup', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  beforeEach(async () => {
    await resetInstance()
  })

  afterAll(async () => {
    await resetInstance()
  })

  describe('needsSetup', () => {
    it('is true while no user exists and follows the database without caching', async () => {
      expect(await needsSetup(payload)).toBe(true)

      const user = await payload.create({
        collection: 'users',
        data: { email: `someone+${run}@marmot.test`, password: 'password-123' },
      })
      expect(await needsSetup(payload)).toBe(false)

      // Not cached: an emptied users table reopens setup (per-route bundles cannot share a flag).
      await payload.delete({ collection: 'users', id: user.id })
      expect(await needsSetup(payload)).toBe(true)
    })

    it('GET /api/setup/status reports needsSetup', async () => {
      const fresh = await (await statusRoute()).json()
      expect(fresh).toEqual({ needsSetup: true })

      await payload.create({
        collection: 'users',
        data: { email: `someone+${run}@marmot.test`, password: 'password-123' },
      })
      const done = await (await statusRoute()).json()
      expect(done).toEqual({ needsSetup: false })
    })
  })

  describe('runSetup', () => {
    it('rolls back the whole transaction when the organization slug is invalid', async () => {
      const slug = 'admin' // reserved
      await expect(runSetup(payload, { ...input, organizationSlug: slug })).rejects.toBeInstanceOf(
        SetupError,
      )
      expect(await countUsers()).toBe(0)
      expect(await countOrgs(slug)).toBe(0)
      expect(await needsSetup(payload)).toBe(true)

      // Also when the slug passes the pre-check but the organization write itself fails: create a
      // colliding slug first so the unique index rejects it inside the transaction.
      const taken = `taken-${run}`
      await payload.create({
        collection: 'organizations',
        data: { name: 'Taken', slug: taken },
        context: { skipOwnerMembership: true },
      })
      await expect(runSetup(payload, { ...input, organizationSlug: taken })).rejects.toThrow()
      expect(await countUsers()).toBe(0)
      expect(await needsSetup(payload)).toBe(true)
    })

    it('creates a superadmin who owns the new organization, then refuses to run again', async () => {
      const { user, organization } = await runSetup(payload, input)

      expect(user.superadmin).toBe(true)
      expect(user.email).toBe(input.email)
      expect(organization.slug).toBe(input.organizationSlug)
      expect(getUserRole(user, organization.id)).toBe('owner')
      expect(await needsSetup(payload)).toBe(false)

      await expect(
        runSetup(payload, { ...input, email: `other+${run}@marmot.test` }),
      ).rejects.toMatchObject({ status: 409 })
      expect(await countUsers()).toBe(1)
    })

    it('logs the new admin in and produces a payload-token cookie', async () => {
      await runSetup(payload, input)
      const session = await createSetupSession(payload, {
        email: input.email,
        password: input.password,
      })
      expect(session.token).toBeTruthy()
      expect(session.cookie).toMatch(/^payload-token=/)
      expect(session.cookie).toMatch(/HttpOnly/i)

      const headers = new Headers({ Authorization: `JWT ${session.token}` })
      const { user } = await payload.auth({ headers })
      expect(user?.email).toBe(input.email)
    })
  })

  describe('POST /api/setup', () => {
    const post = (body: unknown) =>
      setupRoute(
        new Request('http://localhost:3000/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )

    it('validates the body', async () => {
      const res = await post({ ...input, password: 'short' })
      expect(res.status).toBe(400)
      expect(await countUsers()).toBe(0)
    })

    it('creates everything, sets the cookie and returns the redirect target', async () => {
      const res = await post(input)
      expect(res.status).toBe(201)
      expect(res.headers.get('set-cookie')).toMatch(/^payload-token=/)
      const body = await res.json()
      expect(body.redirectTo).toBe(`/${input.organizationSlug}/monitors`)
      expect(body.user.email).toBe(input.email)

      const again = await post({ ...input, email: `again+${run}@marmot.test` })
      expect(again.status).toBe(409)
    })

    it('accepts the same shape the form validates', () => {
      expect(setupSchema.safeParse(input).success).toBe(true)
      expect(setupSchema.safeParse({ ...input, organizationSlug: 'Bad Slug' }).success).toBe(false)
    })
  })

  describe('instance settings', () => {
    beforeEach(() => resetInstanceSettingsCache())

    it('falls back to env defaults when the global has not been saved', async () => {
      const settings = await getInstanceSettings(payload)
      expect(settings).toEqual(defaultInstanceSettings())
      expect(settings.allowSignup).toBe(!env.DISABLE_SIGNUP)
      expect(settings.tlsExpiryNotifyDays).toEqual([7, 14, 21])
      expect(settings.domainExpiryNotifyDays).toEqual([7, 14, 21])
      expect(settings.keepDataPeriodDays).toBe(env.KEEP_DATA_PERIOD_DAYS)
      expect(settings.entryPage).toBe('dashboard')
      expect(settings.primaryBaseUrl).toBe(env.NEXT_PUBLIC_SERVER_URL)
    })

    it('drives canSignUp from allowSignup and refreshes the cache on save', async () => {
      const before = await isSignupAllowed(payload)
      try {
        await payload.updateGlobal({
          slug: 'instance-settings',
          data: { allowSignup: false, tlsExpiryNotifyDays: [3, 30] },
        })
        expect(await isSignupAllowed(payload)).toBe(false)
        expect((await getInstanceSettings(payload)).tlsExpiryNotifyDays).toEqual([3, 30])
        expect(canSignUp(null, !(await isSignupAllowed(payload)))).toBe(false)
        expect(canSignUp({ id: 1, superadmin: true }, true)).toBe(true)

        await payload.updateGlobal({ slug: 'instance-settings', data: { allowSignup: true } })
        expect(await isSignupAllowed(payload)).toBe(true)
        expect(canSignUp(null, false)).toBe(true)
      } finally {
        await payload.updateGlobal({
          slug: 'instance-settings',
          data: { allowSignup: before, tlsExpiryNotifyDays: [7, 14, 21] },
        })
        resetInstanceSettingsCache()
      }
    })

    it('is readable by any user and writable by superadmins only', async () => {
      const { user: member } = await runSetup(payload, input).then(async ({ organization }) => ({
        user: await payload.create({
          collection: 'users',
          data: {
            email: `member+${run}@marmot.test`,
            password: 'password-123',
            organizations: [{ organization: organization.id, role: 'member' }],
          },
        }),
      }))
      const asMember = { ...member, collection: 'users' as const }

      await expect(
        payload.findGlobal({ slug: 'instance-settings', user: asMember, overrideAccess: false }),
      ).resolves.toBeDefined()
      await expect(
        payload.updateGlobal({
          slug: 'instance-settings',
          data: { trustProxy: true },
          user: asMember,
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      await expect(
        payload.findGlobal({ slug: 'instance-settings', overrideAccess: false }),
      ).rejects.toThrow()
    })
  })
})
