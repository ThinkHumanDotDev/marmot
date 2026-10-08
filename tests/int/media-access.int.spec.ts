import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import {
  DELETE as restDelete,
  GET as restGet,
  PATCH as restPatch,
  POST as restPost,
} from '@/app/(payload)/api/[...slug]/route'
import { DELETE as deleteAvatar, POST as uploadAvatar } from '@/app/api/account/avatar/route'
import { DELETE as deleteOrgLogo, POST as uploadOrgLogo } from '@/app/api/orgs/[orgId]/logo/route'
import { POST as uploadPageLogo } from '@/app/api/orgs/[orgId]/status-pages/[id]/logo/route'
import { env } from '@/env'
import type { Media, Organization, StatusPage, User } from '@/payload-types'

/**
 * `media` rows belong to no organization, so the REST/GraphQL API must not write them; the app's
 * upload routes check permissions and store files with `overrideAccess` instead.
 */

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+media-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

async function createSession(
  name: string,
  memberships: [Organization, Role][],
  superadmin = false,
): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, superadmin },
  })
  for (const [org, role] of memberships) {
    await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  }
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

/** 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const headers = (session?: Session): Record<string, string> =>
  session
    ? { Origin: env.NEXT_PUBLIC_SERVER_URL, cookie: session.cookie }
    : { Origin: env.NEXT_PUBLIC_SERVER_URL }

function fileForm(name: string, alt?: string): FormData {
  const form = new FormData()
  form.append('file', new File([PNG], name, { type: 'image/png' }))
  if (alt !== undefined) form.append('_payload', JSON.stringify({ alt }))
  return form
}

const url = (path: string) => `${env.NEXT_PUBLIC_SERVER_URL}${path}`
const slugParams = (...slug: string[]) => ({ params: Promise.resolve({ slug }) })

/** Payload REST, as a browser on the app origin would call it. */
const rest = {
  get: (path: string[], session?: Session) =>
    restGet(
      new Request(url(`/api/${path.join('/')}`), { headers: headers(session) }),
      slugParams(...path),
    ),
  create: (session: Session | undefined, form: FormData) =>
    restPost(
      new Request(url('/api/media'), { method: 'POST', headers: headers(session), body: form }),
      slugParams('media'),
    ),
  patch: (session: Session, id: string | number, body: FormData | Record<string, unknown>) => {
    const isForm = body instanceof FormData
    return restPatch(
      new Request(url(`/api/media/${id}`), {
        method: 'PATCH',
        headers: isForm
          ? headers(session)
          : { ...headers(session), 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
      }),
      slugParams('media', String(id)),
    )
  },
  remove: (session: Session, id: string | number) =>
    restDelete(
      new Request(url(`/api/media/${id}`), { method: 'DELETE', headers: headers(session) }),
      slugParams('media', String(id)),
    ),
}

const routeRequest = (session: Session, method: 'POST' | 'DELETE', form?: FormData) =>
  new Request(url('/api/upload'), { method, headers: headers(session), body: form })

const orgParams = (orgId: string | number) => ({
  params: Promise.resolve({ orgId: String(orgId) }),
})

const mediaCount = async () => (await payload.count({ collection: 'media' })).totalDocs

const findMedia = (id: string | number) =>
  payload.findByID({
    collection: 'media',
    id,
    depth: 0,
    disableErrors: true,
  }) as Promise<Media | null>

let orgA: Organization
let orgB: Organization
let memberA: Session
let adminA: Session
let memberB: Session
let adminB: Session
let superadmin: Session
let pageB: StatusPage
/** Org B's status page logo, uploaded through the builder route. */
let logoB: Media
const mediaIds: (string | number)[] = []

describe('media write access', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Media A', slug: `media-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Media B', slug: `media-b-${run}` },
    })
    memberA = await createSession('member-a', [[orgA, 'member']])
    adminA = await createSession('admin-a', [[orgA, 'admin']])
    memberB = await createSession('member-b', [[orgB, 'member']])
    adminB = await createSession('admin-b', [[orgB, 'admin']])
    superadmin = await createSession('superadmin', [], true)
    pageB = await payload.create({
      collection: 'status-pages',
      data: { organization: orgB.id, title: 'Media B', slug: `media-b-${run}`, published: true },
    })

    const res = await uploadPageLogo(routeRequest(memberB, 'POST', fileForm('b-logo.png')), {
      params: Promise.resolve({ orgId: String(orgB.id), id: String(pageB.id) }),
    })
    expect(res.status).toBe(200)
    const { doc } = (await res.json()) as { doc: StatusPage }
    logoB = doc.logo as Media
    mediaIds.push(logoB.id)
  })

  afterAll(async () => {
    if (orgB?.id !== undefined) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: orgB.id } },
      })
    }
    for (const session of [memberA, adminA, memberB, adminB, superadmin]) {
      if (session) await payload.delete({ collection: 'users', id: session.user.id })
    }
    for (const org of [orgA, orgB]) {
      if (org?.id !== undefined) await payload.delete({ collection: 'organizations', id: org.id })
    }
    for (const id of mediaIds) {
      if (await findMedia(id).catch(() => null)) {
        await payload.delete({ collection: 'media', id, overrideAccess: true })
      }
    }
  })

  it('refuses REST uploads from members and anonymous visitors', async () => {
    const before = await mediaCount()
    const member = await rest.create(memberA, fileForm('sneaky.png', 'sneaky'))
    expect(member.status).toBe(403)
    const anonymous = await rest.create(undefined, fileForm('anon.png', 'anon'))
    expect(anonymous.status).toBe(403)
    expect(await mediaCount()).toBe(before)
  })

  it("does not let a member of org A overwrite org B's logo through REST", async () => {
    const metadata = await rest.patch(memberA, logoB.id, { alt: 'pwned' })
    expect(metadata.status).toBe(403)
    const form = fileForm('replacement.png', 'pwned')
    const file = await rest.patch(memberA, logoB.id, form)
    expect(file.status).toBe(403)
    // Not even org B's own members may bypass the upload route.
    expect((await rest.patch(memberB, logoB.id, { alt: 'direct' })).status).toBe(403)

    const after = await findMedia(logoB.id)
    expect(after?.alt).toBe(logoB.alt)
    expect(after?.filename).toBe(logoB.filename)
  })

  it("does not let a member of org A delete org B's logo through REST", async () => {
    expect((await rest.remove(memberA, logoB.id)).status).toBe(403)
    expect((await rest.remove(adminB, logoB.id)).status).toBe(403)
    expect(await findMedia(logoB.id)).not.toBeNull()
    const page = await payload.findByID({ collection: 'status-pages', id: pageB.id, depth: 0 })
    expect(String(page.logo)).toBe(String(logoB.id))
  })

  it('applies the same rules to Local API calls made for a user', async () => {
    await expect(
      payload.update({
        collection: 'media',
        id: logoB.id,
        data: { alt: 'pwned' },
        user: memberA.user,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    await expect(
      payload.delete({
        collection: 'media',
        id: logoB.id,
        user: memberA.user,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    expect((await findMedia(logoB.id))?.alt).toBe(logoB.alt)
  })

  it('keeps media publicly readable', async () => {
    const res = await rest.get(['media', String(logoB.id)])
    expect(res.status).toBe(200)
    const body = (await res.json()) as Media
    expect(String(body.id)).toBe(String(logoB.id))
    expect(body.url).toMatch(/\/api\/media\/file\/b-logo.*\.png$/)

    const file = await rest.get(['media', 'file', String(logoB.filename)])
    expect(file.status).toBe(200)
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('still lets superadmins manage media directly (admin panel)', async () => {
    const created = await rest.create(superadmin, fileForm('admin.png', 'admin upload'))
    expect(created.status).toBe(201)
    const { doc } = (await created.json()) as { doc: Media }
    mediaIds.push(doc.id)
    expect((await rest.patch(superadmin, doc.id, { alt: 'renamed' })).status).toBe(200)
    expect((await rest.remove(superadmin, doc.id)).status).toBe(200)
    expect(await findMedia(doc.id)).toBeNull()
  })

  it('refuses status page uploads to another organization without storing anything', async () => {
    const before = await mediaCount()
    const res = await uploadPageLogo(routeRequest(memberA, 'POST', fileForm('x.png')), {
      params: Promise.resolve({ orgId: String(orgB.id), id: String(pageB.id) }),
    })
    // Published pages are readable, so this is a permission refusal rather than a 404.
    expect(res.status).toBe(403)
    expect(await mediaCount()).toBe(before)
  })

  describe('organization logo route', () => {
    it('lets admins upload and remove the logo', async () => {
      const res = await uploadOrgLogo(
        routeRequest(adminA, 'POST', fileForm('a-logo.png')),
        orgParams(orgA.id),
      )
      expect(res.status).toBe(200)
      const { logo } = (await res.json()) as { logo: { id: string | number; url: string } }
      mediaIds.push(logo.id)
      expect(logo.url).toMatch(/\/api\/media\/file\/a-logo.*\.png$/)
      const org = await payload.findByID({ collection: 'organizations', id: orgA.id, depth: 0 })
      expect(String(org.logo)).toBe(String(logo.id))

      const removed = await deleteOrgLogo(routeRequest(adminA, 'DELETE'), orgParams(orgA.id))
      expect(removed.status).toBe(200)
      const cleared = await payload.findByID({ collection: 'organizations', id: orgA.id, depth: 0 })
      expect(cleared.logo ?? null).toBeNull()
    })

    it('refuses members without organization:update, and other organizations', async () => {
      const before = await mediaCount()
      const member = await uploadOrgLogo(
        routeRequest(memberA, 'POST', fileForm('m.png')),
        orgParams(orgA.id),
      )
      expect(member.status).toBe(403)
      const otherOrg = await uploadOrgLogo(
        routeRequest(adminA, 'POST', fileForm('b.png')),
        orgParams(orgB.id),
      )
      expect(otherOrg.status).toBe(404)
      expect((await deleteOrgLogo(routeRequest(adminA, 'DELETE'), orgParams(orgB.id))).status).toBe(
        404,
      )
      expect(await mediaCount()).toBe(before)
    })

    it('rejects files that are not images', async () => {
      const form = new FormData()
      form.append('file', new File(['<html><script>alert(1)</script></html>'], 'x.svg'))
      const res = await uploadOrgLogo(routeRequest(adminA, 'POST', form), orgParams(orgA.id))
      expect(res.status).toBe(400)
    })
  })

  describe('account avatar route', () => {
    it('sets and clears the signed-in user’s own avatar', async () => {
      const res = await uploadAvatar(routeRequest(memberA, 'POST', fileForm('me.png')))
      expect(res.status).toBe(200)
      const { avatar } = (await res.json()) as { avatar: { id: string | number } }
      mediaIds.push(avatar.id)
      const user = await payload.findByID({ collection: 'users', id: memberA.user.id, depth: 0 })
      expect(String(user.avatar)).toBe(String(avatar.id))

      expect((await deleteAvatar(routeRequest(memberA, 'DELETE'))).status).toBe(200)
      const cleared = await payload.findByID({ collection: 'users', id: memberA.user.id, depth: 0 })
      expect(cleared.avatar ?? null).toBeNull()
    })

    it('requires a session', async () => {
      const res = await uploadAvatar(
        new Request(url('/api/account/avatar'), {
          method: 'POST',
          headers: headers(),
          body: fileForm('anon.png'),
        }),
      )
      expect(res.status).toBe(401)
    })
  })
})
