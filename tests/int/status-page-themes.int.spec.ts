import fs from 'node:fs/promises'
import path from 'node:path'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { PATCH as patchPage } from '@/app/api/orgs/[orgId]/status-pages/[id]/route'
import {
  DELETE as deleteFavicon,
  POST as uploadFavicon,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/favicon/route'
import { POST as uploadLogo } from '@/app/api/orgs/[orgId]/status-pages/[id]/logo/route'
import { POST as uploadLogoDark } from '@/app/api/orgs/[orgId]/status-pages/[id]/logo-dark/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { GET as manifestRoute } from '@/app/status/[slug]/manifest.json/route'
import { env } from '@/env'
import { buildThemeCss } from '@/lib/status-page-themes'
import type { PublicStatusPageData } from '@/server/status-pages/public'
import type { Media, Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+spt-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

async function createMember(name: string, org: Organization, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

const params = (orgId: string | number, id: string | number) =>
  Promise.resolve({ orgId: String(orgId), id: String(id) })

function jsonRequest(method: string, body: unknown, session: Session): Request {
  return new Request('http://localhost/api/orgs/x/status-pages/y', {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      'content-type': 'application/json',
      cookie: session.cookie,
    },
    body: JSON.stringify(body),
  })
}

function fileRequest(
  session: Session,
  content: Buffer | string,
  name: string,
  type: string,
  method = 'POST',
): Request {
  const form = new FormData()
  form.append('file', new File([content], name, { type }))
  return new Request('http://localhost/api/orgs/x/status-pages/y/asset', {
    method,
    headers: { Origin: env.NEXT_PUBLIC_SERVER_URL, cookie: session.cookie },
    body: form,
  })
}

function bareRequest(session: Session, method: string): Request {
  return new Request('http://localhost/api/orgs/x/status-pages/y/asset', {
    method,
    headers: { Origin: env.NEXT_PUBLIC_SERVER_URL, cookie: session.cookie },
  })
}

const callPublic = async (slug: string) => {
  const res = await (
    publicRoute as unknown as (
      req: Request,
      ctx: { params: Promise<{ slug: string }> },
    ) => Promise<Response>
  )(new Request('http://localhost/api/status-pages/x/public'), {
    params: Promise.resolve({ slug }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PublicStatusPageData
}

/** 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const UPLOADS_DIR = process.env.UPLOADS_DIR || 'uploads'

let org: Organization
let member: Session
let viewer: Session
let page: StatusPage
const mediaIds: (string | number)[] = []

describe('status page themes', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Themes', slug: `spt-${run}` },
    })
    member = await createMember('member', org, 'member')
    viewer = await createMember('viewer', org, 'viewer')
    page = await payload.create({
      collection: 'status-pages',
      data: { organization: org.id, title: 'Acme', slug: `spt-${run}`, published: true },
    })
  })

  afterAll(async () => {
    if (org?.id !== undefined) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
    }
    for (const id of mediaIds) {
      const doc = (await payload
        .findByID({ collection: 'media', id, depth: 0, disableErrors: true })
        .catch(() => null)) as Media | null
      if (doc) await payload.delete({ collection: 'media', id, overrideAccess: true })
    }
    for (const session of [member, viewer]) {
      if (session) await payload.delete({ collection: 'users', id: session.user.id })
    }
    if (org?.id !== undefined) await payload.delete({ collection: 'organizations', id: org.id })
  })

  it('leaves pages without theme settings unchanged', async () => {
    expect(page.themePreset).toBe('default')
    expect(page.themeOverrides ?? null).toBeNull()
    expect(buildThemeCss(page.themePreset, page.themeOverrides)).toBe('')

    const body = await callPublic(page.slug)
    expect(body.config).toMatchObject({
      theme: 'auto',
      themePreset: 'default',
      logo: null,
      logoDark: null,
      favicon: null,
      bannerText: null,
    })
    expect(body.config).not.toHaveProperty('themeOverrides')
  })

  it('saves a preset with dark-mode primary and "down" overrides through the builder API', async () => {
    const res = await patchPage(
      jsonRequest(
        'PATCH',
        {
          themePreset: 'ocean',
          themeOverrides: {
            light: { primary: '' },
            dark: { primary: ' #FF8800 ', destructive: 'rgb(255 64 64)' },
          },
          bannerText: 'Scheduled upgrade tonight',
        },
        member,
      ),
      { params: params(org.id, page.id) },
    )
    expect(res.status).toBe(200)
    const { doc } = (await res.json()) as { doc: StatusPage }
    expect(doc.themePreset).toBe('ocean')
    // Normalised; the empty light override is dropped.
    expect(doc.themeOverrides).toEqual({
      dark: { primary: '#ff8800', destructive: 'rgb(255 64 64)' },
    })

    const css = buildThemeCss(doc.themePreset, doc.themeOverrides)
    expect(css).toMatch(/html\.dark\{[^}]*--primary:#ff8800/)
    expect(css).toMatch(/html\.dark\{[^}]*--status-down:rgb\(255 64 64\)/)
    // Light mode keeps the preset's primary.
    expect(css).toMatch(/html:not\(\.dark\)\{[^}]*--primary:#0b5cad/)

    const body = await callPublic(page.slug)
    expect(body.config).toMatchObject({
      themePreset: 'ocean',
      bannerText: 'Scheduled upgrade tonight',
    })
  })

  it.each([
    ['a named colour', { dark: { primary: 'red' } }],
    ['CSS injection', { dark: { primary: '#fff;}</style><script>alert(1)</script>' } }],
    ['a var() reference', { light: { background: 'var(--x)' } }],
    ['an unknown token', { light: { '--background': '#fff' } }],
    ['an unknown mode', { sepia: { primary: '#fff' } }],
    ['an invalid radius', { radius: '1rem;}' }],
    ['a non-object', '#ffffff'],
  ])('rejects %s', async (_label, themeOverrides) => {
    const res = await patchPage(jsonRequest('PATCH', { themeOverrides }, member), {
      params: params(org.id, page.id),
    })
    expect(res.status).toBe(400)
    const stored = await payload.findByID({ collection: 'status-pages', id: page.id, depth: 0 })
    expect(stored.themeOverrides).toEqual({
      dark: { primary: '#ff8800', destructive: 'rgb(255 64 64)' },
    })
  })

  it('rejects unknown presets and over-long banners, also through the Local API', async () => {
    const res = await patchPage(jsonRequest('PATCH', { themePreset: 'neon' }, member), {
      params: params(org.id, page.id),
    })
    expect(res.status).toBe(400)
    await expect(
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { bannerText: 'x'.repeat(141) },
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { themeOverrides: { light: { primary: 'expression(alert(1))' } } as never },
      }),
    ).rejects.toThrow()
  })

  it('does not let viewers change the theme', async () => {
    const res = await patchPage(jsonRequest('PATCH', { themePreset: 'forest' }, viewer), {
      params: params(org.id, page.id),
    })
    expect(res.status).toBe(403)
  })

  it('uploads light and dark logos and exposes both on the public page', async () => {
    const light = await uploadLogo(fileRequest(member, PNG, 'light.png', 'image/png'), {
      params: params(org.id, page.id),
    })
    expect(light.status).toBe(200)
    const dark = await uploadLogoDark(fileRequest(member, PNG, 'dark.png', 'image/png'), {
      params: params(org.id, page.id),
    })
    expect(dark.status).toBe(200)
    const { doc } = (await dark.json()) as { doc: StatusPage }
    mediaIds.push((doc.logo as Media).id, (doc.logoDark as Media).id)

    const body = await callPublic(page.slug)
    expect(body.config.logo).toMatch(/\/api\/media\/file\/light.*\.png$/)
    expect(body.config.logoDark).toMatch(/\/api\/media\/file\/dark.*\.png$/)
  })

  it('stores a sanitised SVG favicon and serves it in the manifest', async () => {
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="alert(1)"><script>alert(1)</script><circle cx="8" cy="8" r="7" fill="#0b5cad"/></svg>`
    const res = await uploadFavicon(fileRequest(member, svg, 'icon.svg', 'image/svg+xml'), {
      params: params(org.id, page.id),
    })
    expect(res.status).toBe(200)
    const { doc } = (await res.json()) as { doc: StatusPage }
    const favicon = doc.favicon as Media
    mediaIds.push(favicon.id)
    expect(favicon.mimeType).toBe('image/svg+xml')

    const stored = await fs.readFile(path.resolve(UPLOADS_DIR, favicon.filename!), 'utf8')
    expect(stored).toContain('<circle cx="8" cy="8" r="7" fill="#0b5cad"/>')
    expect(stored).not.toMatch(/script|onload|alert/)

    const body = await callPublic(page.slug)
    expect(body.config.favicon).toBe(favicon.url)

    const manifest = await (
      manifestRoute as unknown as (
        req: Request,
        ctx: { params: Promise<{ slug: string }> },
      ) => Promise<Response>
    )(new Request('http://localhost/x'), { params: Promise.resolve({ slug: page.slug }) })
    const json = (await manifest.json()) as { icons: { src: string; type?: string }[] }
    expect(json.icons.map((i) => i.src)).toContain(favicon.url)
  })

  it('rejects oversized, mistyped and malformed favicons', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(101 * 1024)])
    const tooBig = await uploadFavicon(fileRequest(member, big, 'big.png', 'image/png'), {
      params: params(org.id, page.id),
    })
    expect(tooBig.status).toBe(400)
    expect(((await tooBig.json()) as { error: string }).error).toMatch(/100 KB/)

    // A JPEG is a fine logo but not an accepted favicon; the declared type is ignored.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const wrongType = await uploadFavicon(fileRequest(member, jpeg, 'x.png', 'image/png'), {
      params: params(org.id, page.id),
    })
    expect(wrongType.status).toBe(400)

    const html = await uploadFavicon(
      fileRequest(member, '<html><script>alert(1)</script></html>', 'x.svg', 'image/svg+xml'),
      { params: params(org.id, page.id) },
    )
    expect(html.status).toBe(400)

    const entities = await uploadFavicon(
      fileRequest(
        member,
        '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
        'x.svg',
        'image/svg+xml',
      ),
      { params: params(org.id, page.id) },
    )
    expect(entities.status).toBe(400)
  })

  it('refuses uploads from viewers without leaving media behind', async () => {
    const before = await payload.count({ collection: 'media' })
    const res = await uploadFavicon(fileRequest(viewer, PNG, 'v.png', 'image/png'), {
      params: params(org.id, page.id),
    })
    expect(res.status).toBe(403)
    expect((await payload.count({ collection: 'media' })).totalDocs).toBe(before.totalDocs)
  })

  it('removes the favicon', async () => {
    const res = await deleteFavicon(bareRequest(member, 'DELETE'), {
      params: params(org.id, page.id),
    })
    expect(res.status).toBe(200)
    const body = await callPublic(page.slug)
    expect(body.config.favicon).toBeNull()
  })
})
