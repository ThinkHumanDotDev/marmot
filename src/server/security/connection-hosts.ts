/**
 * Hosts named by a driver connection string, for the outbound address guard's save-time check and
 * for the pre-connection check of drivers that cannot be pointed at a vetted address.
 *
 * Understands URL forms (`postgres://u:p@h1:5432,h2/db?host=…`, `mongodb+srv://…`, `mysql://…`,
 * `mssql://…`, `redis://…`) and key/value forms (`host=h port=5432`, `Server=tcp:h,1433;…`). Unix
 * sockets and named pipes are reported as `localSocket`; a missing host means the driver default,
 * `localhost`.
 */
import dns from 'node:dns'

import {
  assertHostsAllowed,
  blockedLocalError,
  hostLocalChecksRefused,
  literalTargetDenial,
  outboundGuardActive,
} from './outbound-guard'

export interface ConnectionTargets {
  hosts: string[]
  /** The string points at a unix socket or named pipe on the worker host. */
  localSocket: boolean
  /** `mongodb+srv://` seed name whose SRV records list the real hosts. */
  srvName?: string
}

const KEY_VALUE_HOST_KEYS = new Set([
  'host',
  'hostaddr',
  'server',
  'data source',
  'address',
  'addr',
  'network address',
  'proxyhost',
])
const SOCKET_KEYS = new Set(['socket', 'socketpath'])

const isSocketPath = (value: string) => value.startsWith('/') || value.startsWith('\\\\')

/** `h`, `h:port`, `[v6]:port`, `tcp:h,1433`, `h\\instance` → bare host. */
function hostOf(raw: string): string {
  let value = raw.trim()
  value = value.replace(/^tcp:/i, '')
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(1, end)
  }
  value = value.split('\\')[0].split(',')[0]
  // `h:port`, but not a bare IPv6 address (several colons).
  const colons = value.split(':').length - 1
  if (colons === 1) value = value.slice(0, value.indexOf(':'))
  if (value === '(local)' || value === '.') return 'localhost'
  return value
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function connectionTargets(connectionString: string): ConnectionTargets {
  const value = connectionString.trim()
  const targets: ConnectionTargets = { hosts: [], localSocket: false }
  const addHost = (raw: string) => {
    const decoded = safeDecode(raw.trim())
    if (!decoded) return
    if (isSocketPath(decoded) || /^(np|lpc):/i.test(decoded) || decoded.endsWith('.sock')) {
      targets.localSocket = true
      return
    }
    const host = hostOf(decoded)
    if (host) targets.hosts.push(host)
  }

  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (scheme) {
    const rest = value.slice(scheme[0].length)
    const authorityEnd = rest.search(/[/?#]/)
    let authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
    const at = authority.lastIndexOf('@')
    if (at !== -1) authority = authority.slice(at + 1)
    const isSrv = scheme[1].toLowerCase() === 'mongodb+srv'
    const parts = authority.split(',').filter((p) => p.trim() !== '')
    if (isSrv && parts[0]) targets.srvName = hostOf(safeDecode(parts[0]))
    else for (const part of parts) addHost(part)

    const queryStart = rest.indexOf('?')
    if (queryStart !== -1) {
      const params = new URLSearchParams(rest.slice(queryStart + 1).split('#')[0])
      for (const [key, param] of params) {
        const k = key.toLowerCase()
        if (SOCKET_KEYS.has(k) && param) targets.localSocket = true
        else if (k === 'host' || k === 'proxyhost') for (const h of param.split(',')) addHost(h)
      }
    }
    if (targets.hosts.length === 0 && !targets.localSocket && !targets.srvName) {
      targets.hosts.push('localhost')
    }
    return targets
  }

  // Key/value form: `;`-separated (SQL Server) or whitespace-separated (libpq).
  const pairs = value.includes(';') ? value.split(';') : value.split(/\s+(?=[\w ]+=)/)
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = pair.slice(0, eq).trim().toLowerCase()
    const raw = pair
      .slice(eq + 1)
      .trim()
      .replace(/^'(.*)'$/, '$1')
    if (SOCKET_KEYS.has(key) && raw) targets.localSocket = true
    else if (key === 'host' || key === 'hostaddr') for (const h of raw.split(',')) addHost(h)
    // SQL Server: `Server=tcp:h,1433` (the comma introduces the port).
    else if (KEY_VALUE_HOST_KEYS.has(key)) addHost(raw)
  }
  if (targets.hosts.length === 0 && !targets.localSocket) targets.hosts.push('localhost')
  return targets
}

/**
 * Pre-connection check of every host in a connection string (SRV targets included). Used for the
 * drivers that connect by name; see the call sites for what is additionally vetted at connect time.
 */
export async function assertConnectionTargetsAllowed(connectionString: string): Promise<void> {
  if (!outboundGuardActive()) return
  const targets = connectionTargets(connectionString)
  if (targets.localSocket && hostLocalChecksRefused()) throw blockedLocalError('A local socket')
  const hosts = [...targets.hosts]
  if (targets.srvName) {
    const records = await dns.promises
      .resolveSrv(`_mongodb._tcp.${targets.srvName}`)
      .catch(() => [])
    hosts.push(...(records.length ? records.map((r) => r.name) : [targets.srvName]))
  }
  await assertHostsAllowed(hosts)
}

/** Save-time fast feedback for a connection string: the first denied literal host, or null. */
export function connectionStringDenial(connectionString: string | null | undefined): string | null {
  if (!connectionString?.trim() || !outboundGuardActive()) return null
  const targets = connectionTargets(connectionString)
  if (targets.localSocket && hostLocalChecksRefused()) {
    return blockedLocalError('A local socket').message
  }
  for (const host of targets.hosts) {
    const denial = literalTargetDenial(host)
    if (denial) return denial
  }
  return null
}
