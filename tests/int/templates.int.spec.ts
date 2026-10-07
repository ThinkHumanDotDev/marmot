import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as createIncidentRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/route'
import { PATCH as patchIncidentRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/route'
import { POST as postUpdateRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/updates/route'
import { PATCH as editUpdateRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/updates/[updateId]/route'
import type { Incident, Organization, StatusPage, Template, User } from '@/payload-types'
import { applyImportPlan } from '@/server/import-export/apply'
import { buildMarmotExport, parseMarmotExport } from '@/server/import-export/marmot'
import type { RequestUser } from '@/server/monitors/http'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+tpl-${run}@marmot.test`
const PASSWORD = 'password-123'

type Id = string | number

let orgA: Organization
let orgB: Organization
let owner: RequestUser
let member: RequestUser
let viewer: RequestUser
let outsider: RequestUser
let page: StatusPage
let otherPage: StatusPage
/** Component (group row) ids of `page`. */
let dbC: string
let apiC: string
let ownerToken: string

async function createUser(name: string, memberships: [Organization, Role][]): Promise<RequestUser> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  for (const [org, role] of memberships) {
    await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  }
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...(fresh as User), collection: 'users' }
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

async function call(
  handler: unknown,
  method: string,
  params: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await (handler as Handler)(
    new Request('http://localhost/api/test', {
      method,
      headers: { 'content-type': 'application/json', authorization: `JWT ${ownerToken}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const asUser = (user: RequestUser) => ({ user, overrideAccess: false }) as const

const createTemplate = (user: RequestUser, data: Partial<Template> & { organization: Id }) =>
  payload.create({
    collection: 'templates',
    data: {
      name: `T ${Math.random().toString(36).slice(2, 8)}`,
      kind: 'incident',
      ...data,
    } as never,
    depth: 0,
    ...asUser(user),
  }) as Promise<Template>

describe('incident and maintenance templates', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const founder = await payload.create({
      collection: 'users',
      data: { email: email('founder'), password: PASSWORD, name: 'Founder' },
    })
    const founderUser = { ...founder, collection: 'users' as const }
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Tpl Acme', slug: `tpl-a-${run}` },
      user: founderUser,
      overrideAccess: false,
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Tpl Other', slug: `tpl-b-${run}` },
      user: founderUser,
      overrideAccess: false,
    })
    owner = await createUser('owner', [[orgA, 'owner']])
    member = await createUser('member', [[orgA, 'member']])
    viewer = await createUser('viewer', [[orgA, 'viewer']])
    outsider = await createUser('outsider', [[orgB, 'owner']])

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: orgA.id,
        title: 'Acme status',
        slug: `tpl-page-${run}`,
        groups: [
          {
            name: 'Core',
            monitors: [
              { type: 'static', name: 'Database' },
              { type: 'static', name: 'API' },
            ],
          },
        ],
      },
    })
    dbC = String(page.groups?.[0]?.monitors?.[0]?.id)
    apiC = String(page.groups?.[0]?.monitors?.[1]?.id)
    otherPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: orgB.id,
        title: 'Other status',
        slug: `tpl-other-${run}`,
        groups: [{ name: 'Core', monitors: [{ type: 'static', name: 'Thing' }] }],
      },
    })

    const { token } = await payload.login({
      collection: 'users',
      data: { email: owner.email, password: PASSWORD },
    })
    ownerToken = token as string
  })

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (!org?.id) continue
      await payload.delete({ collection: 'templates', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'incidents', where: { organization: { equals: org.id } } })
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'organizations', id: org.id })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+tpl-${run}@` } } })
  })

  describe('access', () => {
    it('members create templates, viewers read but cannot write', async () => {
      const template = await createTemplate(member, {
        organization: orgA.id,
        name: 'Database failover',
        title: 'Database failover on {{ page }}',
        body: 'Failing over {{ components }}. Next update by {{ eta }}.',
        status: 'identified',
        statusPage: page.id,
        components: [{ component: dbC, impact: 'major_outage' }],
      })
      expect(template.components).toEqual([
        expect.objectContaining({ component: dbC, impact: 'major_outage' }),
      ])

      const seen = await payload.find({
        collection: 'templates',
        where: { organization: { equals: orgA.id } },
        ...asUser(viewer),
      })
      expect(seen.docs.map((doc) => doc.name)).toContain('Database failover')

      await expect(
        createTemplate(viewer, { organization: orgA.id, name: 'Viewer template' }),
      ).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'templates',
          id: template.id,
          data: { body: 'changed' },
          ...asUser(viewer),
        }),
      ).rejects.toThrow()
      await expect(
        payload.delete({ collection: 'templates', id: template.id, ...asUser(viewer) }),
      ).rejects.toThrow()
    })

    it('other organizations neither see nor create templates of the organization', async () => {
      const seen = await payload.find({
        collection: 'templates',
        where: { organization: { equals: orgA.id } },
        ...asUser(outsider),
      })
      expect(seen.totalDocs).toBe(0)
      await expect(
        createTemplate(outsider, { organization: orgA.id, name: 'Intruder' }),
      ).rejects.toThrow()
    })

    it('names are unique per organization', async () => {
      await createTemplate(owner, { organization: orgA.id, name: 'Unique name' })
      await expect(
        createTemplate(owner, { organization: orgA.id, name: 'Unique name' }),
      ).rejects.toThrow()
      const elsewhere = await createTemplate(outsider, {
        organization: orgB.id,
        name: 'Unique name',
      })
      expect(elsewhere.name).toBe('Unique name')
    })
  })

  describe('validation', () => {
    it('refuses a status page of another organization', async () => {
      await expect(
        createTemplate(owner, { organization: orgA.id, statusPage: otherPage.id }),
      ).rejects.toThrow(/statusPage/)
    })

    it('refuses components that are not on the template’s page, or without a page', async () => {
      await expect(
        createTemplate(owner, {
          organization: orgA.id,
          statusPage: page.id,
          components: [{ component: 'not-a-row', impact: 'major_outage' }],
        }),
      ).rejects.toThrow()
      await expect(
        createTemplate(owner, {
          organization: orgA.id,
          components: [{ component: dbC, impact: 'major_outage' }],
        }),
      ).rejects.toThrow()
      await expect(
        createTemplate(owner, {
          organization: orgA.id,
          statusPage: page.id,
          components: [
            { component: dbC, impact: 'major_outage' },
            { component: dbC, impact: 'partial_outage' },
          ],
        }),
      ).rejects.toThrow()
    })

    it('clears fields that do not apply to the kind', async () => {
      const maintenance = await createTemplate(owner, {
        organization: orgA.id,
        kind: 'maintenance',
        title: 'Planned network maintenance',
        status: 'identified',
        impact: 'major_outage',
        duration: 120,
        statusPage: page.id,
        components: [{ component: dbC, impact: 'major_outage' }],
      })
      expect(maintenance).toMatchObject({ status: null, impact: null, duration: 120 })
      expect(maintenance.components ?? []).toEqual([])

      const incident = await createTemplate(owner, { organization: orgA.id, duration: 30 })
      expect(incident.duration ?? null).toBeNull()
    })

    it('templates of a deleted status page become organization-wide', async () => {
      const temporary = await payload.create({
        collection: 'status-pages',
        data: {
          organization: orgA.id,
          title: 'Temporary',
          slug: `tpl-temp-${run}`,
          groups: [{ name: 'G', monitors: [{ type: 'static', name: 'X' }] }],
        },
      })
      const rowId = String(temporary.groups?.[0]?.monitors?.[0]?.id)
      const template = await createTemplate(owner, {
        organization: orgA.id,
        statusPage: temporary.id,
        components: [{ component: rowId, impact: 'partial_outage' }],
      })
      await payload.delete({ collection: 'status-pages', id: temporary.id })
      const after = await payload.findByID({ collection: 'templates', id: template.id, depth: 0 })
      expect(after.statusPage ?? null).toBeNull()
      expect(after.components ?? []).toEqual([])
    })
  })

  describe('publishing is blocked while placeholders are unfilled', () => {
    const pageParams = () => ({ orgId: String(orgA.id), id: String(page.id) })

    it('refuses a new incident with placeholders in its title or message', async () => {
      const title = await call(createIncidentRoute, 'POST', pageParams(), {
        title: 'Database failover on {{ page }}',
        message: 'Investigating.',
      })
      expect(title.status).toBe(400)
      expect(String(title.json.error ?? title.json.message ?? JSON.stringify(title.json))).toMatch(
        /\{\{ page \}\}/,
      )

      const message = await call(createIncidentRoute, 'POST', pageParams(), {
        title: 'Database failover',
        message: 'Next update by {{ eta }}.',
      })
      expect(message.status).toBe(400)
    })

    it('accepts filled-in text and placeholders inside Markdown code', async () => {
      const created = await call(createIncidentRoute, 'POST', pageParams(), {
        title: 'Database failover',
        status: 'identified',
        message: 'Failing over. Templates use `{{ eta }}` syntax.',
        components: [{ component: dbC, impact: 'major_outage' }],
      })
      expect(created.status).toBe(201)
      const incident = created.json.doc as Incident
      const params = { ...pageParams(), incidentId: String(incident.id) }

      const blockedUpdate = await call(postUpdateRoute, 'POST', params, {
        status: 'monitoring',
        message: 'Fixed at {{ time }}.',
      })
      expect(blockedUpdate.status).toBe(400)

      const blockedRename = await call(patchIncidentRoute, 'PATCH', params, {
        title: 'Failover {{ x }}',
      })
      expect(blockedRename.status).toBe(400)

      const updateId = String(incident.updates?.[0]?.id)
      const blockedEdit = await call(
        editUpdateRoute,
        'PATCH',
        { ...params, updateId },
        { message: 'Now {{ eta }}' },
      )
      expect(blockedEdit.status).toBe(400)

      const posted = await call(postUpdateRoute, 'POST', params, {
        status: 'monitoring',
        message: 'Fixed at 14:00.',
      })
      expect(posted.status).toBe(201)
    })
  })

  describe('export and import', () => {
    it('round-trips templates with their page and components remapped', async () => {
      const exported = await buildMarmotExport(payload, { orgId: orgA.id, user: owner })
      const failover = exported.templates.find((t) => t.name === 'Database failover')
      expect(failover).toMatchObject({
        kind: 'incident',
        status: 'identified',
        statusPage: page.id,
        components: [{ component: dbC, impact: 'major_outage' }],
      })
      const exportedPage = exported.statusPages.find((p) => p.id === page.id)
      expect(exportedPage?.groups[0]?.monitors.map((row) => row.id)).toEqual([dbC, apiC])

      // Import into the other organization (its own slug is taken, so the page gets a suffix).
      const plan = parseMarmotExport(exported)
      const dry = await applyImportPlan(payload, {
        orgId: orgB.id,
        user: outsider,
        plan,
        dryRun: true,
      })
      expect(dry.templates.create).toBeGreaterThan(0)
      // "Unique name" exists in orgB already.
      expect(dry.templates.skipped.map((s) => s.name)).toContain('Unique name')

      const report = await applyImportPlan(payload, {
        orgId: orgB.id,
        user: outsider,
        plan: parseMarmotExport(exported),
        dryRun: false,
      })
      expect(report.templates.created?.length).toBe(report.templates.create)

      const { docs } = await payload.find({
        collection: 'templates',
        where: {
          and: [{ organization: { equals: orgB.id } }, { name: { equals: 'Database failover' } }],
        },
        depth: 0,
      })
      const imported = docs[0] as Template
      expect(imported).toBeDefined()
      expect(String(imported.statusPage)).not.toBe(String(page.id))
      const importedPage = await payload.findByID({
        collection: 'status-pages',
        id: imported.statusPage as Id,
        depth: 0,
      })
      expect(String(importedPage.organization)).toBe(String(orgB.id))
      const newDb = String(importedPage.groups?.[0]?.monitors?.[0]?.id)
      expect(imported.components?.map((row) => [row.component, row.impact])).toEqual([
        [newDb, 'major_outage'],
      ])
      expect(imported.title).toBe('Database failover on {{ page }}')
    })

    it('drops components of templates whose page is not in the file', () => {
      const plan = parseMarmotExport({
        format: 'marmot',
        version: 1,
        templates: [
          {
            name: 'Orphan',
            kind: 'incident',
            statusPage: 999,
            components: [{ component: 'r1', impact: 'major_outage' }],
          },
          { name: 'Broken', kind: 'nope' },
        ],
      })
      expect(plan.templates).toEqual([
        expect.objectContaining({ name: 'Orphan', statusPageKey: null, components: [] }),
      ])
      expect(plan.skipped.templates.map((s) => s.name)).toEqual(['Broken'])
      expect(plan.warnings.some((w) => w.includes('Orphan'))).toBe(true)
    })
  })
})
