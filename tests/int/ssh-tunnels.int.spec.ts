/**
 * SSH tunnels (#160): monitors reaching internal targets through a bastion. The bastion is an
 * in-process ssh2 server that resolves `*.internal` names itself, so a check only succeeds when it
 * really went through the tunnel. Covers host key pinning, credential sealing (never readable,
 * never in responses or the audit log), org scoping and the "Test connection" route.
 */
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'

import { getPayload, type Payload } from 'payload'
import ssh2 from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import type { Role } from '@/access/permissions'
import { GET as restGet } from '@/app/(payload)/api/[...slug]/route'
import { POST as testTunnelRoute } from '@/app/api/orgs/[orgId]/ssh-tunnels/test/route'
import { env } from '@/env'
import type { Monitor, MonitorProxy, Organization, SshTunnel, User } from '@/payload-types'
import { runCheck } from '@/server/engine'
import { hashProbeToken } from '@/server/probes/tokens'
import { closeSshConnections, hostKeyFingerprint } from '@/server/ssh-tunnels'
import '@/server/monitor-types'

const { Server, utils } = ssh2

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `tunnel-${name}+${run}@marmot.test`
const PASSWORD = 'password-123'

const SSH_USER = 'monitor'
const SSH_PASSWORD = `bastion-secret-${run}`
const KEY_PASSPHRASE = `key-passphrase-${run}`

const hostKey = utils.generateKeyPairSync('ed25519')
const otherHostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519', {
  passphrase: KEY_PASSPHRASE,
  cipher: 'aes256-ctr',
  rounds: 16,
})

const fingerprintOf = (publicKey: string) => {
  const parsed = utils.parseKey(publicKey)
  if (parsed instanceof Error) throw parsed
  return hostKeyFingerprint(parsed.getPublicSSH())
}
const HOST_FINGERPRINT = fingerprintOf(hostKey.public)
const WRONG_FINGERPRINT = fingerprintOf(otherHostKey.public)

/** The Postgres the integration tests run on (CI starts it in both database jobs). */
const PG_URL = env.DATABASE_URL.startsWith('postgres')
  ? env.DATABASE_URL
  : 'postgres://marmot:marmot@localhost:5432/marmot'

let org: Organization
let otherOrg: Organization
let owner: User
let admin: User
let member: User
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

async function token(user: User): Promise<string> {
  const result = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return result.token ?? ''
}

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

// ---- The bastion ----------------------------------------------------------------------------------

/** Names only the bastion can resolve. */
const INTERNAL_HOSTS: Record<string, string> = {
  'pg.internal': '',
  'web.internal': '127.0.0.1',
  'closed.internal': '127.0.0.1',
}

let bastion: InstanceType<typeof Server>
let bastionPort = 0
const forwards: string[] = []
const authAttempts: string[] = []

function startBastion(): Promise<void> {
  bastion = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      authAttempts.push(ctx.method)
      if (ctx.username !== SSH_USER) return ctx.reject()
      if (ctx.method === 'password') {
        return ctx.password === SSH_PASSWORD ? ctx.accept() : ctx.reject()
      }
      if (ctx.method === 'publickey') {
        const allowed = utils.parseKey(clientKey.public)
        if (allowed instanceof Error) return ctx.reject()
        if (ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) {
          return ctx.reject()
        }
        if (ctx.signature && ctx.blob && !allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
          return ctx.reject()
        }
        return ctx.accept()
      }
      return ctx.reject(['password', 'publickey'])
    })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        forwards.push(`${info.destIP}:${info.destPort}`)
        const mapped = INTERNAL_HOSTS[info.destIP]
        const host = mapped === '' ? new URL(PG_URL).hostname : (mapped ?? info.destIP)
        const upstream = net.connect(info.destPort, host)
        upstream.once('error', () => reject?.())
        upstream.once('connect', () => {
          const channel = accept?.()
          if (!channel) return upstream.destroy()
          channel.on('error', () => upstream.destroy())
          upstream.removeAllListeners('error')
          upstream.on('error', () => channel.close())
          channel.pipe(upstream).pipe(channel)
        })
      })
    })
  })
  return new Promise((resolve) =>
    bastion.listen(0, '127.0.0.1', () => {
      bastionPort = (bastion.address() as AddressInfo).port
      resolve()
    }),
  )
}

/** HTTP target behind the bastion; records the Host header it was asked for. */
let web: http.Server
let webPort = 0
const webHosts: string[] = []

/** A port nothing listens on. */
let closedPort = 0

// ---- Fixtures --------------------------------------------------------------------------------------

const TUNNEL_DEFAULTS = () => ({
  host: '127.0.0.1',
  port: bastionPort,
  username: SSH_USER,
  authMethod: 'password' as const,
  password: SSH_PASSWORD,
  knownHostFingerprint: HOST_FINGERPRINT,
})

async function createTunnel(data: Partial<SshTunnel> & { name: string }): Promise<SshTunnel> {
  return (await payload.create({
    collection: 'ssh-tunnels',
    data: { organization: org.id, ...TUNNEL_DEFAULTS(), ...data } as never,
    user: await as(admin),
    overrideAccess: false,
    depth: 0,
  })) as SshTunnel
}

const MONITOR_DEFAULTS = {
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

const check = (monitor: Monitor) => runCheck(payload, monitor, 10_000)

let passwordTunnel: SshTunnel
let keyTunnel: SshTunnel

beforeAll(async () => {
  payload = await getPayload({ config })

  owner = await createUser('owner')
  admin = await createUser('admin')
  member = await createUser('member')
  outsider = await createUser('outsider')
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Tunnel Co', slug: `tunnel-co-${run}` },
    user: await as(owner),
    overrideAccess: false,
  })
  otherOrg = await payload.create({
    collection: 'organizations',
    data: { name: 'Elsewhere', slug: `tunnel-elsewhere-${run}` },
    user: await as(outsider),
    overrideAccess: false,
  })
  await addMembership(admin, org, 'admin')
  await addMembership(member, org, 'member')

  await startBastion()
  web = http.createServer((req, res) => {
    webHosts.push(String(req.headers.host))
    res.end('internal-ok')
  })
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', () => resolve()))
  webPort = (web.address() as AddressInfo).port
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  closedPort = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  passwordTunnel = await createTunnel({ name: `pw-bastion-${run}` })
  keyTunnel = await createTunnel({
    name: `key-bastion-${run}`,
    authMethod: 'privateKey',
    password: null,
    privateKey: clientKey.private,
    passphrase: KEY_PASSPHRASE,
  })
})

afterAll(async () => {
  closeSshConnections()
  await new Promise<void>((resolve) => (bastion ? bastion.close(() => resolve()) : resolve()))
  await new Promise<void>((resolve) => (web ? web.close(() => resolve()) : resolve()))
  const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
  if (orgIds.length) {
    const where = { organization: { in: orgIds } }
    await payload.delete({ collection: 'heartbeats', where })
    await payload.delete({ collection: 'monitors', where })
    for (const collection of ['proxies', 'ssh-tunnels'] as const) {
      await payload.delete({ collection, where })
    }
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+${run}@marmot.test` } } })
})

// ---- Checks through the tunnel ---------------------------------------------------------------------

describe('checks through an SSH tunnel', () => {
  it('runs a Postgres monitor against a database only the bastion can resolve', async () => {
    const target = new URL(PG_URL)
    target.hostname = 'pg.internal'
    const monitor = await createMonitor({
      name: 'pg via bastion',
      type: 'postgres',
      databaseConnectionString: target.toString(),
      databaseQuery: 'SELECT 1 AS one',
      sshTunnel: passwordTunnel.id,
    })
    const result = await check(monitor)
    expect(result).toMatchObject({ ok: true, msg: 'Rows: 1' })
    expect(forwards).toContain(`pg.internal:${target.port || 5432}`)

    // Without the tunnel the name does not resolve at all.
    const direct = await check({ ...monitor, sshTunnel: null })
    expect(direct.ok).toBe(false)
  })

  it('runs HTTP and TCP port monitors through a key-authenticated tunnel', async () => {
    const httpMonitor = await createMonitor({
      name: 'http via bastion',
      type: 'http',
      url: `http://web.internal:${webPort}/health`,
      sshTunnel: keyTunnel.id,
    })
    expect(await check(httpMonitor)).toMatchObject({ ok: true, msg: '200 - OK' })
    // The request still names the target, not the loopback endpoint.
    expect(webHosts.at(-1)).toBe(`web.internal:${webPort}`)

    const portMonitor = await createMonitor({
      name: 'port via bastion',
      type: 'port',
      hostname: 'web.internal',
      port: webPort,
      sshTunnel: keyTunnel.id,
    })
    expect(await check(portMonitor)).toMatchObject({ ok: true })
  })

  it('reports a target the bastion cannot reach as a target failure', async () => {
    const monitor = await createMonitor({
      name: 'closed port via bastion',
      type: 'port',
      hostname: 'closed.internal',
      port: closedPort,
      sshTunnel: passwordTunnel.id,
    })
    const result = await check(monitor)
    expect(result.ok).toBe(false)
    expect(result.msg).toContain(
      `SSH tunnel ${passwordTunnel.name} could not reach closed.internal`,
    )
    expect(result.msg).not.toContain('unreachable')
  })

  it('refuses a bastion whose host key does not match, before authenticating', async () => {
    const mismatched = await createTunnel({
      name: `mismatch-${run}`,
      knownHostFingerprint: WRONG_FINGERPRINT,
    })
    const monitor = await createMonitor({
      name: 'pg via impostor',
      type: 'port',
      hostname: 'web.internal',
      port: webPort,
      sshTunnel: mismatched.id,
    })
    const attemptsBefore = authAttempts.length
    const forwardsBefore = forwards.length
    const result = await check(monitor)
    expect(result.ok).toBe(false)
    expect(result.msg).toBe(
      `SSH tunnel ${mismatched.name} unreachable: host key mismatch: the server presented ${HOST_FINGERPRINT}, expected ${WRONG_FINGERPRINT}`,
    )
    expect(authAttempts.length).toBe(attemptsBefore)
    expect(forwards.length).toBe(forwardsBefore)
  })

  it('makes dependent monitors DOWN with "SSH tunnel <name> unreachable" when the bastion is down', async () => {
    const down = await createTunnel({ name: `down-${run}`, port: closedPort })
    const monitor = await createMonitor({
      name: 'via a dead bastion',
      type: 'http',
      url: `http://web.internal:${webPort}/`,
      sshTunnel: down.id,
    })
    const result = await check(monitor)
    expect(result.ok).toBe(false)
    expect(result.msg).toMatch(new RegExp(`^SSH tunnel ${down.name} unreachable: `))
  })

  it('fails authentication with a wrong password without leaking it', async () => {
    const wrong = await createTunnel({ name: `wrong-pw-${run}`, password: 'not-the-password' })
    const monitor = await createMonitor({
      name: 'via wrong password',
      type: 'port',
      hostname: 'web.internal',
      port: webPort,
      sshTunnel: wrong.id,
    })
    const result = await check(monitor)
    expect(result.msg).toBe(`SSH tunnel ${wrong.name} unreachable: authentication failed`)
    expect(result.msg).not.toContain('not-the-password')
  })
})

// ---- Credentials -----------------------------------------------------------------------------------

describe('SSH tunnel credentials', () => {
  it('are sealed at rest and never readable, not even by admins', async () => {
    const raw = (await payload.findByID({
      collection: 'ssh-tunnels',
      id: keyTunnel.id,
      depth: 0,
      overrideAccess: true,
    })) as SshTunnel
    expect(raw.privateKey).toMatch(/^v1\./)
    expect(raw.privateKey).not.toContain('PRIVATE KEY')
    expect(raw.passphrase).toMatch(/^v1\./)
    expect(raw).toMatchObject({ hasPrivateKey: true, hasPassphrase: true, hasPassword: false })

    for (const user of [admin, owner, member]) {
      const doc = await payload.findByID({
        collection: 'ssh-tunnels',
        id: keyTunnel.id,
        depth: 0,
        user: await as(user),
        overrideAccess: false,
      })
      expect(doc).not.toHaveProperty('privateKey')
      expect(doc).not.toHaveProperty('passphrase')
      expect(doc).not.toHaveProperty('password')
      expect(doc.knownHostFingerprint).toBe(HOST_FINGERPRINT)
    }
  })

  it('never appear in REST responses, the create response or the audit log', async () => {
    const response = await restGet(
      new Request(`${env.NEXT_PUBLIC_SERVER_URL}/api/ssh-tunnels?depth=0&limit=100`, {
        headers: {
          Origin: env.NEXT_PUBLIC_SERVER_URL,
          Authorization: `JWT ${await token(admin)}`,
        },
      }),
      { params: Promise.resolve({ slug: ['ssh-tunnels'] }) },
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(passwordTunnel.name)
    for (const secret of [SSH_PASSWORD, KEY_PASSPHRASE, 'PRIVATE KEY', 'v1.']) {
      expect(body).not.toContain(secret)
    }
    // The create operation's own response (what the settings dialog receives) is stripped too.
    expect(JSON.stringify(passwordTunnel)).not.toContain(SSH_PASSWORD)
    expect(JSON.stringify(keyTunnel)).not.toContain('PRIVATE KEY')

    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: { organization: { equals: org.id }, entityType: { equals: 'ssh_tunnel' } },
      depth: 0,
      limit: 100,
      overrideAccess: true,
    })
    expect(docs.length).toBeGreaterThan(0)
    const audit = JSON.stringify(docs)
    for (const secret of [SSH_PASSWORD, KEY_PASSPHRASE, 'PRIVATE KEY']) {
      expect(audit).not.toContain(secret)
    }
  })

  it('keep the stored secret when an update leaves it empty, and drop the other method', async () => {
    const tunnel = await createTunnel({ name: `keep-${run}` })
    const renamed = (await payload.update({
      collection: 'ssh-tunnels',
      id: tunnel.id,
      data: { name: `kept-${run}`, password: '' },
      user: await as(admin),
      overrideAccess: false,
      depth: 0,
    })) as SshTunnel
    expect(renamed.hasPassword).toBe(true)
    const monitor = await createMonitor({
      name: 'after rename',
      type: 'port',
      hostname: 'web.internal',
      port: webPort,
      sshTunnel: tunnel.id,
    })
    expect(await check(monitor)).toMatchObject({ ok: true })

    // Switching to key authentication needs a key and clears the password.
    const missingKey = await fieldErrors(
      payload.update({
        collection: 'ssh-tunnels',
        id: tunnel.id,
        data: { authMethod: 'privateKey' },
        user: await as(admin),
        overrideAccess: false,
      }),
    )
    expect(missingKey.map((e) => e.path)).toContain('privateKey')
    const switched = (await payload.update({
      collection: 'ssh-tunnels',
      id: tunnel.id,
      data: { authMethod: 'privateKey', privateKey: clientKey.private, passphrase: KEY_PASSPHRASE },
      user: await as(admin),
      overrideAccess: false,
      depth: 0,
    })) as SshTunnel
    expect(switched).toMatchObject({ hasPassword: false, hasPrivateKey: true })
  })

  it('validates the fingerprint, the credentials and the private key', async () => {
    const user = await as(admin)
    const create = (data: Record<string, unknown>) =>
      payload.create({
        collection: 'ssh-tunnels',
        data: { organization: org.id, name: 'invalid', ...TUNNEL_DEFAULTS(), ...data } as never,
        user,
        overrideAccess: false,
      })
    expect(
      (await fieldErrors(create({ knownHostFingerprint: 'aa:bb:cc' }))).map((e) => e.path),
    ).toContain('knownHostFingerprint')
    expect((await fieldErrors(create({ password: '' }))).map((e) => e.path)).toContain('password')
    const badKey = await fieldErrors(
      create({ authMethod: 'privateKey', privateKey: clientKey.private, passphrase: 'wrong' }),
    )
    expect(badKey.map((e) => e.path)).toContain('privateKey')

    // Fingerprints are canonicalised: prefix optional, padding dropped.
    const bare = await create({
      name: `bare-${run}`,
      knownHostFingerprint: `${HOST_FINGERPRINT.slice('SHA256:'.length)}=`,
    })
    expect((bare as SshTunnel).knownHostFingerprint).toBe(HOST_FINGERPRINT)
  })
})

// ---- Access and monitor references -----------------------------------------------------------------

describe('SSH tunnel access and monitor references', () => {
  it('lets admins manage tunnels, members only read them, outsiders nothing', async () => {
    await expect(
      payload.create({
        collection: 'ssh-tunnels',
        data: { organization: org.id, name: 'by member', ...TUNNEL_DEFAULTS() } as never,
        user: await as(member),
        overrideAccess: false,
      }),
    ).rejects.toBeTruthy()
    const visible = await payload.find({
      collection: 'ssh-tunnels',
      depth: 0,
      limit: 100,
      user: await as(outsider),
      overrideAccess: false,
    })
    expect(visible.docs.map((doc) => doc.id)).not.toContain(passwordTunnel.id)
  })

  it('refuses another organization’s tunnel, a proxy together with a tunnel and probe locations', async () => {
    const foreign = (await payload.create({
      collection: 'ssh-tunnels',
      data: { organization: otherOrg.id, name: 'foreign', ...TUNNEL_DEFAULTS() } as never,
      overrideAccess: true,
    })) as SshTunnel
    const http = { type: 'http' as const, url: `http://web.internal:${webPort}/` }
    expect(
      (await fieldErrors(createMonitor({ name: 'foreign', ...http, sshTunnel: foreign.id }))).map(
        (e) => e.path,
      ),
    ).toContain('sshTunnel')

    const proxy = (await payload.create({
      collection: 'proxies',
      data: { organization: org.id, protocol: 'http', host: '127.0.0.1', port: 3128 },
      overrideAccess: true,
    })) as MonitorProxy
    expect(
      (
        await fieldErrors(
          createMonitor({ name: 'both', ...http, sshTunnel: passwordTunnel.id, proxy: proxy.id }),
        )
      ).map((e) => e.path),
    ).toContain('sshTunnel')

    const location = await payload.create({
      collection: 'locations',
      data: {
        organization: org.id,
        name: 'Probe',
        slug: `probe-${run}`,
        tokenHash: hashProbeToken(`mp_${randomBytes(8).toString('hex')}`),
        tokenPrefix: randomBytes(4).toString('hex'),
      } as never,
      overrideAccess: true,
    })
    expect(
      (
        await fieldErrors(
          createMonitor({
            name: 'probe',
            ...http,
            sshTunnel: passwordTunnel.id,
            locations: [location.id],
          }),
        )
      ).map((e) => e.path),
    ).toContain('sshTunnel')
    await payload.delete({ collection: 'locations', id: location.id, overrideAccess: true })
  })

  it('drops the tunnel when the type cannot use one and detaches monitors on delete', async () => {
    const tunnel = await createTunnel({ name: `doomed-${run}` })
    const monitor = await createMonitor({
      name: 'detach me',
      type: 'port',
      hostname: 'web.internal',
      port: webPort,
      sshTunnel: tunnel.id,
    })
    const dns = (await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: { type: 'dns', hostname: 'example.com' },
      overrideAccess: true,
      depth: 0,
    })) as Monitor
    expect(dns.sshTunnel ?? null).toBeNull()

    const other = await createMonitor({
      name: 'detach me too',
      type: 'port',
      hostname: 'web.internal',
      port: webPort,
      sshTunnel: tunnel.id,
    })
    await payload.delete({
      collection: 'ssh-tunnels',
      id: tunnel.id,
      user: await as(admin),
      overrideAccess: false,
    })
    const after = (await payload.findByID({
      collection: 'monitors',
      id: other.id,
      depth: 0,
      overrideAccess: true,
    })) as Monitor
    expect(after.sshTunnel ?? null).toBeNull()
  })
})

// ---- Test connection -------------------------------------------------------------------------------

describe('POST /api/orgs/:orgId/ssh-tunnels/test', () => {
  const call = async (user: User, body: Record<string, unknown>) =>
    testTunnelRoute(
      new Request(`http://localhost/api/orgs/${org.id}/ssh-tunnels/test`, {
        method: 'POST',
        headers: { Authorization: `JWT ${await token(user)}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ orgId: String(org.id) }) },
    )

  it('tests saved and unsaved tunnels without returning credentials', async () => {
    const saved = await call(admin, { sshTunnelId: keyTunnel.id })
    expect(saved.status).toBe(200)
    const savedBody = await saved.json()
    expect(savedBody).toMatchObject({ ok: true, fingerprint: HOST_FINGERPRINT })
    expect(JSON.stringify(savedBody)).not.toContain(KEY_PASSPHRASE)

    const unsaved = await call(admin, { ...TUNNEL_DEFAULTS() })
    expect(unsaved.status).toBe(200)
    expect(JSON.stringify(await unsaved.json())).not.toContain(SSH_PASSWORD)

    // Editing a saved tunnel: typed values over the stored ones, stored credentials kept.
    const edited = await call(admin, {
      sshTunnelId: passwordTunnel.id,
      knownHostFingerprint: WRONG_FINGERPRINT,
    })
    expect(edited.status).toBe(400)
    expect(await edited.json()).toMatchObject({ ok: false, fingerprint: HOST_FINGERPRINT })
  })

  it('reads the presented host key, and is closed to members and other organizations', async () => {
    const fetched = await call(admin, {
      host: '127.0.0.1',
      port: bastionPort,
      fetchFingerprint: true,
    })
    expect(await fetched.json()).toEqual({ ok: true, fingerprint: HOST_FINGERPRINT })

    expect((await call(member, { sshTunnelId: passwordTunnel.id })).status).toBe(403)
    expect((await call(outsider, { sshTunnelId: passwordTunnel.id })).status).toBe(403)
  })
})
