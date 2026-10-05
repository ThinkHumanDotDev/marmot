/**
 * Tags, proxies and Docker hosts: org-scoped access, monitor references, and the behaviour that can
 * break silently (requests really going through the proxy, Docker container verdicts).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import type { Role } from '@/access/permissions'
import { POST as testDockerRoute } from '@/app/api/orgs/[orgId]/docker-hosts/test/route'
import type {
  DockerHost,
  Monitor,
  MonitorProxy,
  Organization,
  StatusPage,
  Tag,
  User,
} from '@/payload-types'
import { runCheck } from '@/server/engine'
import { containerVerdict } from '@/server/docker/client'
import { loadOrgState } from '@/server/realtime/state'
import { buildPublicGroups } from '@/server/status-pages/public'
import '@/server/monitor-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `res-${name}+${run}@marmot.test`
const PASSWORD = 'password-123'

let org: Organization
let otherOrg: Organization
let owner: User
let admin: User
let member: User
let viewer: User
let outsider: User

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function createUser(name: string): Promise<User> {
  return payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
}

async function addMembership(user: User, target: Organization, role: Role): Promise<void> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  const rows = (fresh.organizations ?? []).map((row) => ({
    id: row.id,
    organization: typeof row.organization === 'object' ? row.organization.id : row.organization,
    role: row.role,
  }))
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { organizations: [...rows, { organization: target.id, role }] },
    depth: 0,
  })
}

async function authHeaders(user: User): Promise<Record<string, string>> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return { Authorization: `JWT ${token}` }
}

const MONITOR_DEFAULTS = {
  type: 'http' as const,
  url: 'https://example.com',
  active: false,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 10,
}

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    depth: 0,
    overrideAccess: true,
    data: { ...MONITOR_DEFAULTS, organization: org.id, ...data } as never,
  })) as Monitor
}

const asAccess = async (user: User) => ({ user: await as(user), overrideAccess: false as const })

/** Resolves the error's field errors, or throws when the operation succeeded. */
async function fieldErrors(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return (
      (error as { data?: { errors?: { path: string; message: string }[] } }).data?.errors ?? [
        { path: '', message: (error as Error).message },
      ]
    )
  }
  throw new Error('expected the operation to fail')
}

async function rejects(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeTruthy()
}

// ---- Local servers --------------------------------------------------------------------------------

const listen = (server: net.Server) =>
  new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const listenPath = (server: net.Server, socketPath: string) =>
  new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
const close = (server: net.Server | undefined) =>
  new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
const portOf = (server: net.Server) => (server.address() as AddressInfo).port

/** Target the monitors check: answers 200 "target-ok" and records the Host header. */
let target: http.Server
const targetHits: string[] = []

/** Forward HTTP proxy (absolute-form requests), records the requests it relayed. */
let httpProxy: http.Server
const proxyHits: { url: string; auth: string | undefined }[] = []

/** Minimal SOCKS4/SOCKS5 CONNECT server, records the destinations it dialled. */
let socksServer: net.Server
const socksHits: { version: number; host: string; port: number; user?: string }[] = []
const SOCKS_USER = 'sockuser'
const SOCKS_PASS = 'sockpass'

function startSocks(requireAuth: boolean): net.Server {
  return net.createServer((client) => {
    client.once('data', (greeting) => {
      const version = greeting[0]
      const connect = (host: string, port: number, reply: Buffer, user?: string) => {
        socksHits.push({ version, host, port, user })
        const upstream = net.connect(port, host, () => {
          client.write(reply)
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
      }

      if (version === 4) {
        const port = greeting.readUInt16BE(2)
        const ip = [...greeting.subarray(4, 8)].join('.')
        const userEnd = greeting.indexOf(0, 8)
        const user = greeting.subarray(8, userEnd).toString()
        connect(ip, port, Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]), user)
        return
      }
      if (version !== 5) return client.destroy()

      const methods = [...greeting.subarray(2, 2 + greeting[1])]
      const handleRequest = (user?: string) =>
        client.once('data', (req) => {
          const atyp = req[3]
          let host: string
          let offset: number
          if (atyp === 1) {
            host = [...req.subarray(4, 8)].join('.')
            offset = 8
          } else if (atyp === 3) {
            const len = req[4]
            host = req.subarray(5, 5 + len).toString()
            offset = 5 + len
          } else if (atyp === 4) {
            const words: string[] = []
            for (let i = 0; i < 16; i += 2) words.push(req.readUInt16BE(4 + i).toString(16))
            host = words.join(':')
            offset = 20
          } else {
            return client.destroy()
          }
          const port = req.readUInt16BE(offset)
          connect(host, port, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), user)
        })

      if (requireAuth) {
        if (!methods.includes(2)) return client.end(Buffer.from([5, 0xff]))
        client.write(Buffer.from([5, 2]))
        client.once('data', (auth) => {
          const ulen = auth[1]
          const user = auth.subarray(2, 2 + ulen).toString()
          const plen = auth[2 + ulen]
          const pass = auth.subarray(3 + ulen, 3 + ulen + plen).toString()
          if (user !== SOCKS_USER || pass !== SOCKS_PASS) return client.end(Buffer.from([1, 1]))
          client.write(Buffer.from([1, 0]))
          handleRequest(user)
        })
      } else {
        client.write(Buffer.from([5, 0]))
        handleRequest()
      }
    })
    client.on('error', () => {})
  })
}

/** Fake Docker Engine API, served on a unix socket and on TCP. */
let dockerSocketServer: http.Server
let dockerTcpServer: http.Server
let socketDir: string
let socketPath: string

const CONTAINERS: Record<string, { State: Record<string, unknown> }> = {
  web: { State: { Status: 'running', Running: true, Health: { Status: 'healthy' } } },
  plain: { State: { Status: 'running', Running: true } },
  stopped: { State: { Status: 'exited', Running: false } },
  restarting: { State: { Status: 'restarting', Running: true, Restarting: true } },
  sick: { State: { Status: 'running', Running: true, Health: { Status: 'unhealthy' } } },
}

const dockerHandler: http.RequestListener = (req, res) => {
  const url = new URL(req.url ?? '/', 'http://docker')
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/containers/json') {
    res.end(
      JSON.stringify([
        { Id: 'a', ImageID: 'sha256:1' },
        { Id: 'b', ImageID: 'sha256:2' },
      ]),
    )
    return
  }
  const match = /^\/containers\/([^/]+)\/json$/.exec(url.pathname)
  const container = match ? CONTAINERS[decodeURIComponent(match[1])] : undefined
  if (!container) {
    res.statusCode = 404
    res.end(JSON.stringify({ message: `No such container: ${match?.[1] ?? '?'}` }))
    return
  }
  res.end(JSON.stringify({ Id: match?.[1], ...container }))
}

beforeAll(async () => {
  payload = await getPayload({ config })

  owner = await createUser('owner')
  admin = await createUser('admin')
  member = await createUser('member')
  viewer = await createUser('viewer')
  outsider = await createUser('outsider')

  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Resources Co', slug: `resources-co-${run}` },
    user: await as(owner),
    overrideAccess: false,
  })
  otherOrg = await payload.create({
    collection: 'organizations',
    data: { name: 'Elsewhere', slug: `elsewhere-${run}` },
    user: await as(outsider),
    overrideAccess: false,
  })
  await addMembership(admin, org, 'admin')
  await addMembership(member, org, 'member')
  await addMembership(viewer, org, 'viewer')

  target = http.createServer((req, res) => {
    targetHits.push(String(req.headers.host))
    res.end('target-ok')
  })
  await new Promise<void>((resolve) => target.listen(0, () => resolve()))

  httpProxy = http.createServer((req, res) => {
    proxyHits.push({ url: String(req.url), auth: req.headers['proxy-authorization'] })
    const upstream = new URL(String(req.url))
    const forward = http.request(
      { host: upstream.hostname, port: upstream.port, path: upstream.pathname, method: req.method },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    forward.on('error', () => res.writeHead(502).end())
    req.pipe(forward)
  })
  await listen(httpProxy)

  socksServer = startSocks(false)
  await listen(socksServer)

  socketDir = mkdtempSync(path.join(os.tmpdir(), 'marmot-docker-'))
  socketPath = path.join(socketDir, 'docker.sock')
  dockerSocketServer = http.createServer(dockerHandler)
  await listenPath(dockerSocketServer, socketPath)
  dockerTcpServer = http.createServer(dockerHandler)
  await listen(dockerTcpServer)
})

afterAll(async () => {
  await Promise.all([
    close(target),
    close(httpProxy),
    close(socksServer),
    close(dockerSocketServer),
    close(dockerTcpServer),
  ])
  if (socketDir) rmSync(socketDir, { recursive: true, force: true })

  const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
  if (orgIds.length) {
    const where = { organization: { in: orgIds } }
    await payload.delete({ collection: 'heartbeats', where })
    await payload.delete({ collection: 'monitors', where })
    for (const collection of ['tags', 'proxies', 'docker-hosts'] as const) {
      await payload.delete({ collection, where })
    }
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+${run}@marmot.test` } } })
})

// ---- Access control -------------------------------------------------------------------------------

describe('tags', () => {
  it('viewers read, members write, outsiders see nothing', async () => {
    await rejects(
      payload.create({
        collection: 'tags',
        data: { organization: org.id, name: 'nope', color: '#DC2626' },
        ...(await asAccess(viewer)),
      }),
    )
    const tag = (await payload.create({
      collection: 'tags',
      data: { organization: org.id, name: 'prod', color: '#DC2626' },
      ...(await asAccess(member)),
    })) as Tag

    const asViewer = await payload.find({
      collection: 'tags',
      where: { id: { equals: tag.id } },
      ...(await asAccess(viewer)),
    })
    expect(asViewer.docs).toHaveLength(1)

    const asOutsider = await payload.find({
      collection: 'tags',
      where: { id: { equals: tag.id } },
      ...(await asAccess(outsider)),
    })
    expect(asOutsider.docs).toHaveLength(0)

    // A member of another organization cannot create tags in this one.
    await rejects(
      payload.create({
        collection: 'tags',
        data: { organization: org.id, name: 'intruder', color: '#DC2626' },
        ...(await asAccess(outsider)),
      }),
    )
  })

  it('validates the colour and keeps names unique per organization', async () => {
    const errors = await fieldErrors(
      payload.create({
        collection: 'tags',
        data: { organization: org.id, name: 'bad-colour', color: 'red' },
        overrideAccess: true,
      }),
    )
    expect(errors[0]).toMatchObject({ path: 'color' })

    await payload.create({
      collection: 'tags',
      data: { organization: org.id, name: 'unique-name', color: '#059669' },
      overrideAccess: true,
    })
    await rejects(
      payload.create({
        collection: 'tags',
        data: { organization: org.id, name: 'unique-name', color: '#059669' },
        overrideAccess: true,
      }),
    )
    // The same name is fine in another organization.
    await payload.create({
      collection: 'tags',
      data: { organization: otherOrg.id, name: 'unique-name', color: '#059669' },
      overrideAccess: true,
    })
  })

  it('attaches to monitors with values and is removed from them on delete', async () => {
    const env = (await payload.create({
      collection: 'tags',
      data: { organization: org.id, name: 'env', color: '#2563EB' },
      overrideAccess: true,
    })) as Tag
    const team = (await payload.create({
      collection: 'tags',
      data: { organization: org.id, name: 'team', color: '#7C3AED' },
      overrideAccess: true,
    })) as Tag
    const monitor = await createMonitor({
      name: 'tagged',
      tags: [
        { tag: env.id, value: 'prod' },
        { tag: team.id, value: null },
      ] as Monitor['tags'],
    })
    expect(monitor.tags).toHaveLength(2)

    await payload.delete({ collection: 'tags', id: env.id, overrideAccess: true })
    const fresh = (await payload.findByID({
      collection: 'monitors',
      id: monitor.id,
      depth: 0,
    })) as Monitor
    expect(fresh.tags?.map((row) => String(row.tag))).toEqual([String(team.id)])
  })
})

describe('proxies', () => {
  it('members read without the password, admins write and read it, viewers see nothing', async () => {
    const data = {
      organization: org.id,
      protocol: 'http' as const,
      host: 'proxy.internal',
      port: 3128,
      auth: true,
      username: 'svc',
      password: 's3cret',
    }
    await rejects(payload.create({ collection: 'proxies', data, ...(await asAccess(member)) }))
    const proxy = (await payload.create({
      collection: 'proxies',
      data,
      ...(await asAccess(admin)),
    })) as MonitorProxy

    const asAdmin = (await payload.findByID({
      collection: 'proxies',
      id: proxy.id,
      ...(await asAccess(admin)),
    })) as MonitorProxy
    expect(asAdmin.password).toBe('s3cret')

    const asMember = (await payload.findByID({
      collection: 'proxies',
      id: proxy.id,
      ...(await asAccess(member)),
    })) as MonitorProxy
    expect(asMember.username).toBe('svc')
    expect(asMember.password).toBeUndefined()

    // Populated through a monitor, the password is stripped as well.
    const monitor = await createMonitor({ name: 'proxied', proxy: proxy.id } as never)
    const viaMonitor = (await payload.findByID({
      collection: 'monitors',
      id: monitor.id,
      depth: 1,
      ...(await asAccess(member)),
    })) as Monitor
    expect(typeof viaMonitor.proxy === 'object' && viaMonitor.proxy?.password).toBeFalsy()

    // Viewers hold no `proxy:read` anywhere: the query is refused outright.
    await rejects(
      payload.find({
        collection: 'proxies',
        where: { id: { equals: proxy.id } },
        ...(await asAccess(viewer)),
      }),
    )
  })

  it('keeps a single default proxy per organization and requires a username with auth', async () => {
    const base = { organization: org.id, protocol: 'https' as const, port: 8443 }
    const first = (await payload.create({
      collection: 'proxies',
      data: { ...base, host: 'first.internal', default: true },
      overrideAccess: true,
    })) as MonitorProxy
    const second = (await payload.create({
      collection: 'proxies',
      data: { ...base, host: 'second.internal', default: true },
      overrideAccess: true,
    })) as MonitorProxy
    const elsewhere = (await payload.create({
      collection: 'proxies',
      data: { ...base, organization: otherOrg.id, host: 'other.internal', default: true },
      overrideAccess: true,
    })) as MonitorProxy

    const reload = (id: MonitorProxy['id']) =>
      payload.findByID({ collection: 'proxies', id, depth: 0 }) as Promise<MonitorProxy>
    expect((await reload(first.id)).default).toBe(false)
    expect((await reload(second.id)).default).toBe(true)
    expect((await reload(elsewhere.id)).default).toBe(true)

    const errors = await fieldErrors(
      payload.create({
        collection: 'proxies',
        data: { ...base, host: 'auth.internal', auth: true },
        overrideAccess: true,
      }),
    )
    expect(errors[0]).toMatchObject({ path: 'username' })
  })

  it('detaches from monitors when deleted', async () => {
    const proxy = (await payload.create({
      collection: 'proxies',
      data: { organization: org.id, protocol: 'http', host: 'gone.internal', port: 8080 },
      overrideAccess: true,
    })) as MonitorProxy
    const monitor = await createMonitor({ name: 'loses-proxy', proxy: proxy.id } as never)
    await payload.delete({ collection: 'proxies', id: proxy.id, overrideAccess: true })
    const fresh = (await payload.findByID({
      collection: 'monitors',
      id: monitor.id,
      depth: 0,
    })) as Monitor
    expect(fresh.proxy ?? null).toBeNull()
  })
})

describe('docker hosts', () => {
  it('members read, admins write, outsiders see nothing', async () => {
    const data = {
      organization: org.id,
      name: 'local',
      connectionType: 'socket' as const,
      socketPath,
    }
    await rejects(payload.create({ collection: 'docker-hosts', data, ...(await asAccess(member)) }))
    const host = (await payload.create({
      collection: 'docker-hosts',
      data,
      ...(await asAccess(admin)),
    })) as DockerHost
    expect(host.url ?? null).toBeNull()

    const visible = async (user: User) =>
      (
        await payload.find({
          collection: 'docker-hosts',
          where: { id: { equals: host.id } },
          ...(await asAccess(user)),
        })
      ).docs.length
    expect(await visible(member)).toBe(1)
    // The outsider may read Docker hosts of their own organization only.
    expect(await visible(outsider)).toBe(0)
    // Viewers hold no `docker-host:read` anywhere: the query is refused outright.
    await rejects(visible(viewer))
  })

  it('validates the connection settings', async () => {
    const tcp = await fieldErrors(
      payload.create({
        collection: 'docker-hosts',
        data: { organization: org.id, name: 'bad-url', connectionType: 'tcp', url: 'docker:2375' },
        overrideAccess: true,
      }),
    )
    expect(tcp[0]).toMatchObject({ path: 'url' })
    const socket = await fieldErrors(
      payload.create({
        collection: 'docker-hosts',
        data: { organization: org.id, name: 'bad-path', connectionType: 'socket', socketPath: 'x' },
        overrideAccess: true,
      }),
    )
    expect(socket[0]).toMatchObject({ path: 'socketPath' })
  })
})

describe('monitor references', () => {
  it("rejects another organization's tags, proxy and Docker host", async () => {
    const foreignTag = (await payload.create({
      collection: 'tags',
      data: { organization: otherOrg.id, name: 'foreign', color: '#DB2777' },
      overrideAccess: true,
    })) as Tag
    const foreignProxy = (await payload.create({
      collection: 'proxies',
      data: { organization: otherOrg.id, protocol: 'http', host: 'foreign.internal', port: 1 },
      overrideAccess: true,
    })) as MonitorProxy
    const foreignHost = (await payload.create({
      collection: 'docker-hosts',
      data: { organization: otherOrg.id, name: 'foreign', connectionType: 'tcp', url: 'tcp://x:1' },
      overrideAccess: true,
    })) as DockerHost

    const asMember = await asAccess(member)
    const create = (data: Record<string, unknown>) =>
      payload.create({
        collection: 'monitors',
        data: { ...MONITOR_DEFAULTS, organization: org.id, name: 'cross-org', ...data } as never,
        ...asMember,
      })

    expect((await fieldErrors(create({ tags: [{ tag: foreignTag.id }] })))[0]).toMatchObject({
      path: 'tags',
    })
    expect((await fieldErrors(create({ proxy: foreignProxy.id })))[0]).toMatchObject({
      path: 'proxy',
    })
    expect(
      (
        await fieldErrors(
          create({ type: 'docker', dockerHost: foreignHost.id, dockerContainer: 'web' }),
        )
      )[0],
    ).toMatchObject({ path: 'dockerHost' })
  })
})

// ---- Proxy behaviour ------------------------------------------------------------------------------

describe('HTTP monitors through a proxy', () => {
  const targetUrl = () => `http://127.0.0.1:${portOf(target)}/health`

  async function proxyDoc(data: Partial<MonitorProxy>): Promise<MonitorProxy> {
    return (await payload.create({
      collection: 'proxies',
      data: {
        organization: org.id,
        protocol: 'http',
        host: '127.0.0.1',
        port: 1,
        ...data,
      } as never,
      overrideAccess: true,
    })) as MonitorProxy
  }

  it('sends the request through an HTTP proxy with Proxy-Authorization', async () => {
    const proxy = await proxyDoc({
      protocol: 'http',
      port: portOf(httpProxy),
      auth: true,
      username: 'svc',
      password: 'pw',
    })
    const monitor = await createMonitor({
      name: 'via-http-proxy',
      url: targetUrl(),
      proxy: proxy.id,
    } as never)
    proxyHits.length = 0

    const result = await runCheck(payload, monitor, 5000)
    expect(result).toMatchObject({ ok: true, msg: '200 - OK' })
    expect(proxyHits).toHaveLength(1)
    expect(proxyHits[0].url).toBe(targetUrl())
    expect(proxyHits[0].auth).toBe(`Basic ${Buffer.from('svc:pw').toString('base64')}`)
  })

  it('connects directly when the proxy is inactive', async () => {
    const proxy = await proxyDoc({ protocol: 'http', port: portOf(httpProxy), active: false })
    const monitor = await createMonitor({
      name: 'inactive-proxy',
      url: targetUrl(),
      proxy: proxy.id,
    } as never)
    proxyHits.length = 0
    const result = await runCheck(payload, monitor, 5000)
    expect(result.ok).toBe(true)
    expect(proxyHits).toHaveLength(0)
  })

  it.each(['socks5', 'socks5h', 'socks', 'socks4'] as const)(
    'tunnels through a %s proxy',
    async (protocol) => {
      const proxy = await proxyDoc({ protocol, port: portOf(socksServer) })
      // A hostname target shows who resolved it: socks5h/socks send it to the proxy.
      const url = `http://localhost:${portOf(target)}/health`
      const monitor = await createMonitor({
        name: `via-${protocol}`,
        url,
        proxy: proxy.id,
      } as never)
      socksHits.length = 0

      const result = await runCheck(payload, monitor, 5000)
      expect(result).toMatchObject({ ok: true, msg: '200 - OK' })
      expect(socksHits).toHaveLength(1)
      expect(socksHits[0].version).toBe(protocol === 'socks4' ? 4 : 5)
      expect(socksHits[0].port).toBe(portOf(target))
      if (protocol === 'socks5h' || protocol === 'socks') {
        expect(socksHits[0].host).toBe('localhost')
      } else {
        expect(net.isIP(socksHits[0].host)).not.toBe(0)
      }
    },
  )

  it('authenticates to a SOCKS5 proxy and fails cleanly on bad credentials', async () => {
    const authSocks = startSocks(true)
    await listen(authSocks)
    try {
      const good = await proxyDoc({
        protocol: 'socks5',
        port: portOf(authSocks),
        auth: true,
        username: SOCKS_USER,
        password: SOCKS_PASS,
      })
      const ok = await createMonitor({
        name: 'socks-auth',
        url: targetUrl(),
        proxy: good.id,
      } as never)
      socksHits.length = 0
      expect((await runCheck(payload, ok, 5000)).ok).toBe(true)
      expect(socksHits[0]?.user).toBe(SOCKS_USER)

      const bad = await proxyDoc({
        protocol: 'socks5',
        port: portOf(authSocks),
        auth: true,
        username: SOCKS_USER,
        password: 'wrong',
      })
      const ko = await createMonitor({
        name: 'socks-bad-auth',
        url: targetUrl(),
        proxy: bad.id,
      } as never)
      const result = await runCheck(payload, ko, 5000)
      expect(result.ok).toBe(false)
    } finally {
      await close(authSocks)
    }
  })
})

// ---- Docker behaviour -----------------------------------------------------------------------------

describe('docker monitor type', () => {
  let socketHost: DockerHost
  let tcpHost: DockerHost

  beforeAll(async () => {
    socketHost = (await payload.create({
      collection: 'docker-hosts',
      data: { organization: org.id, name: 'mock-socket', connectionType: 'socket', socketPath },
      overrideAccess: true,
    })) as DockerHost
    tcpHost = (await payload.create({
      collection: 'docker-hosts',
      data: {
        organization: org.id,
        name: 'mock-tcp',
        connectionType: 'tcp',
        url: `tcp://127.0.0.1:${portOf(dockerTcpServer)}`,
      },
      overrideAccess: true,
    })) as DockerHost
  })

  const check = async (host: DockerHost, container: string) =>
    runCheck(
      payload,
      await createMonitor({
        name: `docker-${container}`,
        type: 'docker',
        url: null,
        dockerHost: host.id,
        dockerContainer: container,
      } as never),
      5000,
    )

  it('reports container states over the unix socket', async () => {
    expect(await check(socketHost, 'web')).toMatchObject({ ok: true, status: 'up', msg: 'healthy' })
    expect(await check(socketHost, 'plain')).toMatchObject({ ok: true, status: 'up' })
    expect(await check(socketHost, 'restarting')).toMatchObject({ ok: true, status: 'pending' })
    expect(await check(socketHost, 'stopped')).toMatchObject({
      ok: false,
      msg: 'Container State is exited',
    })
    expect(await check(socketHost, 'sick')).toMatchObject({
      ok: false,
      msg: 'Container State is unhealthy according to its healthcheck',
    })
    expect(await check(socketHost, 'missing')).toMatchObject({
      ok: false,
      msg: 'Docker API returned 404: No such container: missing',
    })
  })

  it('reports container states over TCP (tcp:// rewritten to http://)', async () => {
    expect(await check(tcpHost, 'web')).toMatchObject({ ok: true, status: 'up' })
    expect(await check(tcpHost, 'stopped')).toMatchObject({ ok: false })
  })

  it('maps health statuses like Uptime Kuma', () => {
    expect(containerVerdict(undefined).status).toBe('down')
    expect(containerVerdict({ Running: true, Paused: true }).msg).toBe(
      'Container is in a paused state',
    )
    expect(containerVerdict({ Running: true, Health: { Status: 'starting' } })).toEqual({
      status: 'pending',
      msg: 'starting',
    })
    expect(containerVerdict({ Running: true, Health: { Status: 'none' } }).status).toBe('up')
  })

  it('tests a connection through the endpoint (admins only)', async () => {
    const call = async (user: User, body: unknown) =>
      testDockerRoute(
        new Request(`http://localhost/api/orgs/${org.id}/docker-hosts/test`, {
          method: 'POST',
          headers: { ...(await authHeaders(user)), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ orgId: String(org.id) }) },
      )

    const saved = await call(admin, { dockerHostId: socketHost.id })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ ok: true, containers: 2 })

    const unsaved = await call(admin, {
      connectionType: 'tcp',
      url: `tcp://127.0.0.1:${portOf(dockerTcpServer)}`,
    })
    expect(await unsaved.json()).toEqual({ ok: true, containers: 2 })

    const unreachable = await call(admin, {
      connectionType: 'socket',
      socketPath: path.join(socketDir, 'nope.sock'),
    })
    expect(unreachable.status).toBe(400)
    expect((await unreachable.json()).ok).toBe(false)

    expect((await call(member, { dockerHostId: socketHost.id })).status).toBe(403)

    // Another organization's host is not reachable through this organization's URL.
    const foreign = (await payload.create({
      collection: 'docker-hosts',
      data: { organization: otherOrg.id, name: 'theirs', connectionType: 'socket', socketPath },
      overrideAccess: true,
    })) as DockerHost
    expect((await call(admin, { dockerHostId: foreign.id })).status).toBe(404)
  })
})

// ---- Tag chips ------------------------------------------------------------------------------------

describe('tag chips', () => {
  it('reach the realtime monitor list and, with showTags, public status pages', async () => {
    const tag = (await payload.create({
      collection: 'tags',
      data: { organization: org.id, name: 'region', color: '#D97706' },
      overrideAccess: true,
    })) as Tag
    const monitor = await createMonitor({
      name: 'chips',
      active: true,
      tags: [{ tag: tag.id, value: 'eu' }] as Monitor['tags'],
    })

    const state = await loadOrgState(payload, org.id, { heartbeatLimit: 0, importantLimit: 0 })
    const listed = state.monitors.find((m) => m.id === String(monitor.id))
    expect(listed?.tags).toEqual([
      { id: String(tag.id), name: 'region', color: '#D97706', value: 'eu' },
    ])

    const page = (showTags: boolean) =>
      ({
        id: 0,
        organization: org.id,
        showTags,
        groups: [{ name: 'Services', monitors: [{ monitor: monitor.id }] }],
      }) as unknown as StatusPage
    const [withTags] = await buildPublicGroups(payload, page(true))
    // Public pages get name, colour and value only — no internal ids.
    expect(withTags.monitors[0].tags).toEqual([{ name: 'region', color: '#D97706', value: 'eu' }])
    const [withoutTags] = await buildPublicGroups(payload, page(false))
    expect(withoutTags.monitors[0].tags).toBeUndefined()
  })
})
