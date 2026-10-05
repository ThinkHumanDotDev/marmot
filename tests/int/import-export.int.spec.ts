import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as exportRoute } from '@/app/api/orgs/[orgId]/export/route'
import { POST as importRoute } from '@/app/api/orgs/[orgId]/import/route'
import { POST as importKumaRoute } from '@/app/api/orgs/[orgId]/import/uptime-kuma/route'
import { env } from '@/env'
import type { ImportReport } from '@/lib/import-export'
import type { Monitor, Notification, Organization, StatusPage, User } from '@/payload-types'
import type { MarmotExport } from '@/server/import-export/marmot'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+imp-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

const kumaBackup = () =>
  JSON.parse(
    readFileSync(path.join(process.cwd(), 'tests/fixtures/uptime-kuma-backup.json'), 'utf8'),
  ) as Record<string, unknown>

async function createMember(name: string, orgs: [Organization, Role][]): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  for (const [org, role] of orgs) {
    await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  }
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

const params = (orgId: string | number) => Promise.resolve({ orgId: String(orgId) })

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
function request(url: string, body: unknown, session?: Session, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
}

const importKuma = (org: Organization, body: unknown, session?: Session, dryRun = false) =>
  importKumaRoute(
    request(
      `http://localhost/api/orgs/${org.id}/import/uptime-kuma${dryRun ? '?dryRun=1' : ''}`,
      body,
      session,
    ),
    { params: params(org.id) },
  )

const importAny = (org: Organization, body: unknown, session?: Session, dryRun = false) =>
  importRoute(
    request(
      `http://localhost/api/orgs/${org.id}/import${dryRun ? '?dryRun=1' : ''}`,
      body,
      session,
    ),
    { params: params(org.id) },
  )

const exportOrg = (org: Organization, session?: Session) =>
  exportRoute(request(`http://localhost/api/orgs/${org.id}/export`, undefined, session, 'GET'), {
    params: params(org.id),
  })

const countIn = (collection: 'monitors' | 'notifications' | 'status-pages', org: Organization) =>
  payload
    .count({ collection, where: { organization: { equals: org.id } } })
    .then((r) => r.totalDocs)

const idOf = (value: unknown): string =>
  String(
    value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value,
  )

let orgA: Organization
let orgB: Organization
let orgC: Organization
let owner: Session
let member: Session
let viewer: Session
let outsider: Session

describe('import / export', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const mk = (name: string, slug: string) =>
      payload.create({ collection: 'organizations', data: { name, slug: `${slug}-${run}` } })
    orgA = await mk('Imp A', 'imp-a')
    orgB = await mk('Imp B', 'imp-b')
    orgC = await mk('Imp C', 'imp-c')
    owner = await createMember('owner', [
      [orgA, 'owner'],
      [orgB, 'owner'],
    ])
    member = await createMember('member', [[orgC, 'member']])
    viewer = await createMember('viewer', [[orgA, 'viewer']])
    outsider = await createMember('outsider', [])
  })

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id, orgC?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'incidents', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'status-pages', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+imp-${run}@marmot.test` } },
    })
  })

  describe('permissions and validation', () => {
    it('requires a session and monitor:create in the organization', async () => {
      expect((await importKuma(orgA, kumaBackup())).status).toBe(401)
      expect((await importKuma(orgA, kumaBackup(), viewer)).status).toBe(403)
      expect((await importKuma(orgA, kumaBackup(), outsider)).status).toBe(403)
      expect((await exportOrg(orgA, viewer)).status).toBe(403)
      expect((await exportOrg(orgA)).status).toBe(401)
    })

    it('rejects invalid JSON and unrecognised files with 400', async () => {
      expect((await importAny(orgA, '{not json', owner)).status).toBe(400)
      const res = await importAny(orgA, { hello: 'world' }, owner)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        errors: [{ message: expect.stringContaining('Unrecognised file') }],
      })
      // The Kuma-only endpoint does not accept a Marmot export.
      expect((await importKuma(orgA, { format: 'marmot', version: 1 }, owner)).status).toBe(400)
    })
  })

  describe('Uptime Kuma backup', () => {
    it('dry run reports the plan without writing anything', async () => {
      const res = await importKuma(orgA, kumaBackup(), owner, true)
      expect(res.status).toBe(200)
      const report = (await res.json()) as ImportReport
      expect(report).toMatchObject({
        format: 'uptime-kuma',
        dryRun: true,
        monitors: { create: 8 },
        notifications: { create: 2 },
        statusPages: { create: 0 },
      })
      expect(report.monitors.created).toBeUndefined()
      expect(report.monitors.skipped).toHaveLength(2)
      expect(report.notifications.skipped).toHaveLength(2)
      expect(report.tags.skipped.map((t) => t.name)).toEqual(['prod', 'region', 'unused'])
      expect(await countIn('monitors', orgA)).toBe(0)
      expect(await countIn('notifications', orgA)).toBe(0)
    })

    it('commits monitors with group parents, notification links and push tokens', async () => {
      const res = await importKuma(orgA, kumaBackup(), owner)
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.dryRun).toBe(false)
      expect(report.monitors.created).toHaveLength(8)
      expect(report.notifications.created).toHaveLength(2)
      expect(await countIn('monitors', orgA)).toBe(8)
      expect(await countIn('notifications', orgA)).toBe(2)

      const { docs } = await payload.find({
        collection: 'monitors',
        where: { organization: { equals: orgA.id } },
        depth: 0,
        limit: 100,
      })
      const monitors = docs as Monitor[]
      const byName = (name: string) => monitors.find((m) => m.name === name)!
      const channels = (
        await payload.find({
          collection: 'notifications',
          where: { organization: { equals: orgA.id } },
          depth: 0,
        })
      ).docs as Notification[]
      const slack = channels.find((c) => c.type === 'slack')!
      const telegram = channels.find((c) => c.type === 'telegram')!
      expect(slack).toMatchObject({ name: 'Ops Slack', isDefault: true, active: true })
      expect(slack.config).toMatchObject({ channel: '#ops', channelNotify: true })
      expect(telegram.config).toMatchObject({ chatId: '-1001234567890' })

      const group = byName('Production')
      expect(group.type).toBe('group')
      expect(group.parent ?? null).toBeNull()
      expect(idOf(byName('Website').parent)).toBe(String(group.id))
      expect(idOf(byName('API keyword').parent)).toBe(String(group.id))
      expect(byName('JSON health').parent ?? null).toBeNull()

      expect((byName('Website').notifications ?? []).map(idOf).sort()).toEqual(
        [String(slack.id), String(telegram.id)].sort(),
      )
      // Link to the skipped PagerTree channel dropped; Slack kept.
      expect((byName('API keyword').notifications ?? []).map(idOf)).toEqual([String(slack.id)])
      expect((byName('Gateway ping').notifications ?? []).map(idOf)).toEqual([String(telegram.id)])
      expect(byName('Gateway ping').interval).toBe(20)
      expect(byName('SSH').active).toBe(false)
      expect(byName('Nightly backup job').pushToken).toBe('kumaPushToken0123')
      expect(byName('API keyword').basicAuthPass).toBe('s3cret')
    })

    it('links to an existing channel of the same name instead of duplicating it', async () => {
      const file = kumaBackup()
      file.monitorList = (file.monitorList as unknown[]).filter(
        (m) => (m as { name: string }).name === 'Nightly backup job',
      )
      const res = await importKuma(orgA, file, owner)
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.notifications.create).toBe(0)
      expect(report.notifications.skipped).toEqual(
        expect.arrayContaining([
          { name: 'Ops Slack', reason: expect.stringContaining('already exists') },
          { name: 'Alerts Telegram', reason: expect.stringContaining('already exists') },
        ]),
      )
      expect(await countIn('notifications', orgA)).toBe(2)
      const slack = (
        await payload.find({
          collection: 'notifications',
          where: { and: [{ organization: { equals: orgA.id } }, { type: { equals: 'slack' } }] },
          depth: 0,
        })
      ).docs[0]
      const created = await payload.findByID({
        collection: 'monitors',
        id: report.monitors.created![0],
        depth: 0,
      })
      expect((created.notifications ?? []).map(idOf)).toEqual([String(slack.id)])
    })

    it('members import monitors but channels are skipped with a warning', async () => {
      const res = await importKuma(orgC, kumaBackup(), member)
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.monitors.create).toBe(8)
      expect(report.notifications.create).toBe(0)
      expect(report.notifications.skipped).toEqual(
        expect.arrayContaining([
          { name: 'Ops Slack', reason: expect.stringContaining('may not create notification') },
        ]),
      )
      expect(report.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('admin role')]),
      )
      expect(await countIn('notifications', orgC)).toBe(0)
      const website = (
        await payload.find({
          collection: 'monitors',
          where: { and: [{ organization: { equals: orgC.id } }, { name: { equals: 'Website' } }] },
          depth: 0,
        })
      ).docs[0]
      expect(website.notifications ?? []).toEqual([])
    })
  })

  describe('Marmot export → import round trip', () => {
    let exported: MarmotExport

    it('exports the organization as a downloadable JSON file', async () => {
      // A status page with a group of imported monitors and an incident.
      const monitors = (
        await payload.find({
          collection: 'monitors',
          where: { organization: { equals: orgA.id } },
          depth: 0,
          limit: 100,
        })
      ).docs as Monitor[]
      const website = monitors.find((m) => m.name === 'Website')!
      const page = await payload.create({
        collection: 'status-pages',
        data: {
          organization: orgA.id,
          title: 'Public status',
          slug: `imp-status-${run}`,
          published: true,
          domains: [{ hostname: `status-${run}.example.com` }],
          groups: [{ name: 'Core', monitors: [{ monitor: website.id, sendUrl: true }] }],
        } as never,
        depth: 0,
      })
      await payload.create({
        collection: 'incidents',
        data: {
          statusPage: page.id,
          organization: orgA.id,
          title: 'Degraded',
          content: 'Investigating',
          style: 'warning',
        } as never,
        depth: 0,
      })

      const res = await exportOrg(orgA, owner)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toMatch(
        new RegExp(`attachment; filename="marmot-export-imp-a-${run}-\\d{4}-\\d{2}-\\d{2}\\.json"`),
      )
      exported = (await res.json()) as MarmotExport
      expect(exported).toMatchObject({
        format: 'marmot',
        version: 1,
        organization: { slug: `imp-a-${run}` },
      })
      expect(exported.monitors).toHaveLength(9)
      expect(exported.notifications).toHaveLength(2)
      // Secrets are exported as stored.
      expect(exported.notifications.find((n) => n.type === 'telegram')!.config.botToken).toBe(
        '123456:ABC-DEF',
      )
      const site = exported.monitors.find((m) => m.name === 'Website')!
      const group = exported.monitors.find((m) => m.name === 'Production')!
      expect(String(site.parent)).toBe(String(group.id))
      expect(site.notifications.map(String).sort()).toEqual(
        exported.notifications.map((n) => String(n.id)).sort(),
      )
      expect(exported.statusPages).toHaveLength(1)
      expect(exported.statusPages[0]).toMatchObject({
        slug: `imp-status-${run}`,
        domains: [`status-${run}.example.com`],
        groups: [{ name: 'Core', monitors: [{ monitor: site.id, sendUrl: true }] }],
        incidents: [{ title: 'Degraded', style: 'warning', active: true }],
      })
    })

    it('imports the export into another organization with remapped ids', async () => {
      const dry = await importAny(orgB, exported, owner, true)
      expect(dry.status).toBe(200)
      const dryReport = (await dry.json()) as ImportReport
      expect(dryReport).toMatchObject({
        format: 'marmot',
        monitors: { create: 9 },
        notifications: { create: 2 },
        statusPages: { create: 1 },
      })
      // Slug and custom domain are taken by orgA's page.
      expect(dryReport.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`imported as "imp-status-${run}-2"`),
          expect.stringContaining(`status-${run}.example.com`),
        ]),
      )
      expect(await countIn('monitors', orgB)).toBe(0)

      const res = await importAny(orgB, exported, owner)
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.monitors.created).toHaveLength(9)
      expect(report.notifications.created).toHaveLength(2)
      expect(report.statusPages.created).toHaveLength(1)

      const monitors = (
        await payload.find({
          collection: 'monitors',
          where: { organization: { equals: orgB.id } },
          depth: 0,
          limit: 100,
        })
      ).docs as Monitor[]
      const byName = (name: string) => monitors.find((m) => m.name === name)!
      const group = byName('Production')
      expect(idOf(byName('Website').parent)).toBe(String(group.id))
      expect(byName('Nightly backup job').pushToken).toBe('kumaPushToken0123')

      const channels = (
        await payload.find({
          collection: 'notifications',
          where: { organization: { equals: orgB.id } },
          depth: 0,
        })
      ).docs as Notification[]
      expect(channels.map((c) => c.type).sort()).toEqual(['slack', 'telegram'])
      expect((byName('Website').notifications ?? []).map(idOf).sort()).toEqual(
        channels.map((c) => String(c.id)).sort(),
      )
      // Ids in orgB differ from orgA's: nothing points back at the source organization.
      for (const monitor of monitors) {
        expect(idOf(monitor.organization)).toBe(String(orgB.id))
        for (const n of monitor.notifications ?? []) {
          expect(channels.some((c) => String(c.id) === idOf(n))).toBe(true)
        }
      }

      const page = (await payload.findByID({
        collection: 'status-pages',
        id: report.statusPages.created![0],
        depth: 0,
      })) as StatusPage
      expect(page.slug).toBe(`imp-status-${run}-2`)
      expect(page.domains ?? []).toEqual([])
      expect(idOf(page.groups![0].monitors![0].monitor)).toBe(String(byName('Website').id))
      const incidents = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: page.id } },
        depth: 0,
      })
      expect(incidents.docs).toHaveLength(1)
      expect(incidents.docs[0]).toMatchObject({ title: 'Degraded', style: 'warning' })
      expect(idOf(incidents.docs[0].organization)).toBe(String(orgB.id))
    })
  })
})
