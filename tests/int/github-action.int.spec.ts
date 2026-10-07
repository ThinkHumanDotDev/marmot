/**
 * The GitHub Action (#118) end to end on the server side: `runAction` in run mode against the real
 * monitor list and "check now" routes (#98), authenticated with organization API keys (#115), with
 * the checks run by a real BullMQ worker on a queue with a random prefix.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { QueueEvents } from 'bullmq'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import type { ActionIo } from '@/action/github'
import { runAction } from '@/action/main'
import * as checkRoute from '@/app/api/orgs/[orgId]/monitors/[id]/check/route'
import * as monitorsRoute from '@/app/api/orgs/[orgId]/monitors/route'
import type { Monitor, Organization } from '@/payload-types'
import { generateApiKey } from '@/server/api-keys'
import {
  createQueue,
  QUEUE_NAMES,
  setOnDemandTransport,
  startCheckWorker,
  type ChecksQueue,
} from '@/server/engine'
import { createRedis } from '@/server/redis'

type Handler = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>

const ROUTES: [RegExp, string[], Handler | undefined][] = [
  [/^\/api\/orgs\/([^/]+)\/monitors$/, ['orgId'], monitorsRoute.GET as Handler],
  [/^\/api\/orgs\/([^/]+)\/monitors\/([^/]+)\/check$/, ['orgId', 'id'], checkRoute.POST as Handler],
]

/** `fetch` that hands requests to the route handlers instead of the network. */
const routeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input as string, init)
  const { pathname } = new URL(request.url)
  for (const [pattern, names, handler] of ROUTES) {
    const match = pattern.exec(pathname)
    if (!match || !handler) continue
    const params = Object.fromEntries(
      names.map((name, i) => [name, decodeURIComponent(match[i + 1])]),
    )
    return handler(request, { params: Promise.resolve(params) })
  }
  return Response.json({ errors: [{ message: 'Not Found' }] }, { status: 404 })
}

let payload: Payload
const run = Date.now().toString(36)
let server: http.Server
let baseUrl: string
let org: Organization
let writeKey: string
let readKey: string
let queue: ChecksQueue
let events: QueueEvents
let worker: ReturnType<typeof startCheckWorker>
const prefix = `marmot-test-gha-${Math.random().toString(36).slice(2, 10)}`

async function mintKey(scope: 'read' | 'write') {
  const generated = generateApiKey()
  await payload.create({
    collection: 'api-keys',
    overrideAccess: true,
    data: {
      organization: org.id,
      name: `action ${scope}`,
      scope,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
    },
  })
  return generated.key
}

async function createMonitor(key: string, name: string, path: string) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      type: 'http',
      key,
      name,
      url: `${baseUrl}${path}`,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      timeout: 5,
      organization: org.id,
    } as never,
  })) as Monitor
}

async function action(inputs: Record<string, string>, key = writeKey) {
  const written: Record<string, string> = {}
  let stdout = ''
  const io: ActionIo = {
    env: {
      INPUT_URL: 'http://localhost:3000',
      'INPUT_API-KEY': key,
      INPUT_ORG: String(org.id),
      GITHUB_STEP_SUMMARY: '/summary.md',
      GITHUB_OUTPUT: '/output.txt',
      ...inputs,
    },
    stdout: (text) => void (stdout += text),
    readFile: async () => {
      throw new Error('ENOENT')
    },
    appendFile: async (path, text) => void (written[path] = (written[path] ?? '') + text),
    sleep: async () => undefined,
    fetch: routeFetch,
  }
  const code = await runAction(io)
  return { code, stdout, summary: written['/summary.md'] ?? '' }
}

describe('GitHub Action against the check-now API', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    server = http.createServer((req, res) => {
      res.statusCode = req.url === '/fail' ? 503 : 200
      res.end('hello')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Action org', slug: `gha-${run}` },
    })
    writeKey = await mintKey('write')
    readKey = await mintKey('read')
    await createMonitor('api', 'API', '/ok')
    await createMonitor('broken', 'Broken', '/fail')

    queue = createQueue(QUEUE_NAMES.checks, { prefix })
    events = new QueueEvents(QUEUE_NAMES.checks, { connection: createRedis(), prefix })
    await events.waitUntilReady()
    worker = startCheckWorker(payload, { prefix, concurrency: 2 })
    setOnDemandTransport({ queue, events })
  })

  afterAll(async () => {
    setOnDemandTransport(undefined)
    await worker?.close()
    await events?.close()
    if (queue) {
      await queue.obliterate({ force: true })
      await queue.close()
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (org) {
      await payload.delete({
        collection: 'heartbeats',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'api-keys', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
  })

  it('passes when the listed monitors are up (write key)', async () => {
    const result = await action({ INPUT_MONITORS: 'api' })
    expect(result.code).toBe(0)
    expect(result.summary).toContain('**1 passed, 0 failed, 0 skipped**')
    expect(result.summary).toMatch(/\| ✅ passed \| API <code>api<\/code> \| up \|/)
  })

  it('fails the job when a monitor is down', async () => {
    const result = await action({ INPUT_MONITORS: 'api, broken' })
    expect(result.code).toBe(1)
    expect(result.summary).toContain('**1 passed, 1 failed, 0 skipped**')
    expect(result.summary).toMatch(/\| ❌ failed \| Broken <code>broken<\/code> \| down \|/)
    expect(result.stdout).toContain('::error title=Broken%3A down::')
  })

  it('reports a read key as an error: checks need a write key', async () => {
    const result = await action({ INPUT_MONITORS: 'api' }, readKey)
    expect(result.code).toBe(1)
    expect(result.summary).toMatch(/\| ❌ failed \| API <code>api<\/code> \| error \|.*403/)
  })
})
