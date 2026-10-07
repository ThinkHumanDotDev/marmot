/**
 * Outbound address guard: the single place where monitor checks and notification deliveries decide
 * whether they may connect to an address. Configured by `MONITOR_DENY_PRIVATE_ADDRESSES`,
 * `MONITOR_DENY_CIDRS` and `MONITOR_ALLOW_CIDRS` (see docs/Security.md).
 *
 * The check runs after DNS resolution, at connect time: every helper here resolves the hostname
 * (through `dns.lookup`, so odd IPv4 literals such as `2130706433`, `0x7f.1` or `127.1` are
 * normalised the way the OS resolver does), rejects the target when *any* resolved address is
 * denied, and hands the caller the vetted address to connect to. Nothing resolves the name a second
 * time, so DNS rebinding cannot swap the address between the check and the connection.
 *
 * - HTTP (undici): `guardConnector` wraps a connector, so every connection of an agent, including
 *   each redirect hop, is checked. `guardedFetch` is `fetch` through such an agent.
 * - `net` / `tls` based drivers: `guardedLookup` (a `lookup` for `net.connect`) plus
 *   `guardedNetConnect` / `guardNetSocket`, which also check IP literals (Node skips `lookup` for those).
 * - Everything else: `resolveGuardedTarget` returns the vetted address to connect to.
 *
 * When the guard is off (the default) every helper is a pass-through and nothing is resolved early.
 */
import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'

import { Agent, buildConnector, fetch as undiciFetch, FormData as UndiciFormData } from 'undici'

import { env } from '@/env'

import { AddressPolicy, parseCidrList, stripAddress, type AddressVerdict } from './address-policy'

let cached: { key: string; policy: AddressPolicy } | undefined

/** The policy for the current environment (rebuilt when the variables change, e.g. in tests). */
export function getAddressPolicy(): AddressPolicy {
  const key = [
    env.MONITOR_DENY_PRIVATE_ADDRESSES,
    env.MONITOR_DENY_CIDRS,
    env.MONITOR_ALLOW_CIDRS,
  ].join('|')
  if (cached?.key !== key) {
    cached = {
      key,
      policy: new AddressPolicy({
        denyPrivate: env.MONITOR_DENY_PRIVATE_ADDRESSES,
        denyCidrs: parseCidrList(env.MONITOR_DENY_CIDRS),
        allowCidrs: parseCidrList(env.MONITOR_ALLOW_CIDRS),
      }),
    }
  }
  return cached.policy
}

/** Whether outbound addresses are checked at all. */
export const outboundGuardActive = (): boolean => getAddressPolicy().active

/**
 * Whether host-local monitor types (Tailscale ping, Docker socket hosts, the browser engine) and
 * host-local notification tools (Apprise) are refused: they would reach the network without
 * passing through this guard.
 */
export const hostLocalChecksRefused = (): boolean => env.MONITOR_DENY_PRIVATE_ADDRESSES

/** Raised (or passed to socket callbacks) when a target is denied. Never retried. */
export class BlockedAddressError extends Error {
  readonly code = 'EADDRBLOCKED'
  constructor(message: string) {
    super(message)
    this.name = 'BlockedAddressError'
  }
}

const SETTING = { private: 'MONITOR_DENY_PRIVATE_ADDRESSES', denied: 'MONITOR_DENY_CIDRS' } as const

/** `Blocked: <host> resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)`. */
export function blockedError(
  host: string,
  reason: Exclude<AddressVerdict, { allowed: true }>['reason'],
) {
  if (reason === 'invalid') {
    return new BlockedAddressError(`Blocked: ${host} did not resolve to a valid IP address`)
  }
  const kind = reason === 'private' ? 'a private' : 'a denied'
  return new BlockedAddressError(
    `Blocked: ${host} resolves to ${kind} address (${SETTING[reason]})`,
  )
}

/** Error for targets the guard cannot vet at all (unix sockets, named pipes, local tools). */
export function blockedLocalError(what: string): BlockedAddressError {
  return new BlockedAddressError(
    `Blocked: ${what} is not allowed on this instance (MONITOR_DENY_PRIVATE_ADDRESSES)`,
  )
}

/** Throws `BlockedAddressError` unless the host-local feature `what` is allowed. */
export function assertHostLocalAllowed(what: string): void {
  if (hostLocalChecksRefused()) throw blockedLocalError(what)
}

/** Find the `Blocked: … (MONITOR_…)` message in an error, its causes or its message text. */
export function findBlockedMessage(err: unknown, depth = 0): string | null {
  if (!err || depth > 5) return null
  if (err instanceof BlockedAddressError) return err.message
  if (err instanceof AggregateError) {
    for (const inner of err.errors) {
      const found = findBlockedMessage(inner, depth + 1)
      if (found) return found
    }
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const match = message.match(/Blocked: .*?(?:\(MONITOR_[A-Z_]+\)|valid IP address)/)
  if (match) return match[0]
  return findBlockedMessage((err as { cause?: unknown }).cause, depth + 1)
}

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** Resolve `host` (IP literals included) to every address `dns.lookup` returns. */
async function resolveAll(host: string, family: 0 | 4 | 6 = 0): Promise<ResolvedAddress[]> {
  const bare = stripAddress(host)
  const literal = net.isIP(bare)
  if (literal) return [{ address: bare, family: literal as 4 | 6 }]
  const results = await dns.promises.lookup(bare, { all: true, family })
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))
}

/** Throw when any of `addresses` is denied. */
function assertAllAllowed(host: string, addresses: readonly { address: string }[]): void {
  const policy = getAddressPolicy()
  if (addresses.length === 0) throw blockedError(host, 'invalid')
  for (const { address } of addresses) {
    const verdict = policy.classify(address)
    if (!verdict.allowed) throw blockedError(stripAddress(host), verdict.reason)
  }
}

/**
 * Resolve `host` and check every address. Resolves with the address to connect to (the first one
 * `dns.lookup` returns, IPv4 first when `family` is 4), or `null` when the guard is off: the caller
 * then connects to `host` exactly as before.
 */
export async function resolveGuardedTarget(
  host: string,
  family: 0 | 4 | 6 = 0,
): Promise<ResolvedAddress | null> {
  if (!outboundGuardActive()) return null
  const addresses = await resolveAll(host, family)
  assertAllAllowed(host, addresses)
  return addresses[0]
}

/**
 * Pre-connection check only: resolve and vet every host, but let the driver connect by name.
 * Used where a driver offers no hook to connect to a given address (see the call sites for the
 * residual time-of-check/time-of-use window).
 */
export async function assertHostsAllowed(hosts: readonly string[]): Promise<void> {
  if (!outboundGuardActive()) return
  for (const host of hosts) {
    const addresses = await resolveAll(host)
    assertAllAllowed(host, addresses)
  }
}

/** Synchronous verdict for an IP literal, or `null` when `host` is not an IP literal. */
function literalVerdict(host: string): AddressVerdict | null {
  const bare = stripAddress(host)
  return net.isIP(bare) ? getAddressPolicy().classify(bare) : null
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void

/**
 * Drop-in `lookup` for `net.connect` / `tls.connect` / `http.request`: resolves through
 * `dns.lookup`, fails with `BlockedAddressError` when any address is denied and otherwise returns
 * exactly what was vetted (so the socket connects to a checked address).
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions | number | LookupCallback,
  maybeCallback?: LookupCallback,
): void {
  const callback = (typeof options === 'function' ? options : maybeCallback) as LookupCallback
  const opts: dns.LookupOptions =
    typeof options === 'object' && options !== null
      ? options
      : typeof options === 'number'
        ? { family: options }
        : {}
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err, opts.all ? [] : '')
    try {
      if (outboundGuardActive()) assertAllAllowed(hostname, addresses)
    } catch (blocked) {
      return callback(blocked as NodeJS.ErrnoException, opts.all ? [] : '')
    }
    if (opts.all) return callback(null, addresses)
    const first = addresses[0]
    callback(null, first.address, first.family)
  })
}

/** A socket that fails with `err` on the next tick (after the caller attached its listeners). */
function failedSocket(err: Error): net.Socket {
  const socket = new net.Socket()
  process.nextTick(() => socket.destroy(err))
  return socket
}

export type GuardedNetOptions = (net.NetConnectOpts | tls.ConnectionOptions) & {
  host?: string
  port?: number
  path?: string
}

/**
 * `net.connect` (or `tls.connect` with `secure`) through the guard: unix sockets are refused, IP
 * literals are checked here and names go through `guardedLookup`. Pass-through when the guard is off.
 */
export function guardedNetConnect(
  options: GuardedNetOptions,
  { secure = false, onConnect }: { secure?: boolean; onConnect?: () => void } = {},
): net.Socket {
  const open = (opts: GuardedNetOptions) =>
    secure
      ? tls.connect(opts as tls.ConnectionOptions, onConnect)
      : net.connect(opts as net.NetConnectOpts, onConnect)
  if (!outboundGuardActive()) return open(options)
  if (options.path) {
    return hostLocalChecksRefused()
      ? failedSocket(blockedLocalError('A local socket'))
      : open(options)
  }
  const host = options.host ?? 'localhost'
  const verdict = literalVerdict(host)
  if (verdict && !verdict.allowed) return failedSocket(blockedError(host, verdict.reason))
  return open({ ...options, lookup: guardedLookup } as GuardedNetOptions)
}

/**
 * Patch `socket.connect` so drivers that create the socket themselves and call
 * `connect(port, host)` later (node-postgres' `stream` option) connect through the guard.
 */
export function guardNetSocket(socket: net.Socket): net.Socket {
  if (!outboundGuardActive()) return socket
  const original = socket.connect.bind(socket) as (...args: unknown[]) => net.Socket
  const patched = (...args: unknown[]): net.Socket => {
    const [first, second] = args
    let options: GuardedNetOptions
    if (typeof first === 'object' && first !== null) options = first as GuardedNetOptions
    else if (typeof first === 'string' && !/^\d+$/.test(first)) options = { path: first }
    else options = { port: Number(first), host: typeof second === 'string' ? second : undefined }
    if (options.path) {
      if (!hostLocalChecksRefused()) return original(options)
      process.nextTick(() => socket.destroy(blockedLocalError('A local socket')))
      return socket
    }
    const host = options.host ?? 'localhost'
    const verdict = literalVerdict(host)
    if (verdict && !verdict.allowed) {
      process.nextTick(() => socket.destroy(blockedError(host, verdict.reason)))
      return socket
    }
    return original({ ...options, lookup: guardedLookup })
  }
  socket.connect = patched as typeof socket.connect
  return socket
}

/**
 * Wrap an undici connector: before each connection the origin hostname is resolved and vetted, and
 * the connection goes to the vetted address (TLS still verifies, and SNI still sends, the original
 * name). Checked per connection, so redirects to other hosts are covered hop by hop.
 */
export function guardConnector(connector: buildConnector.connector): buildConnector.connector {
  return (options, callback) => {
    if (!outboundGuardActive()) return connector(options, callback)
    const hostname = stripAddress(options.hostname)
    resolveGuardedTarget(hostname).then(
      (target) => {
        if (!target) return connector(options, callback)
        const servername = options.servername || (net.isIP(hostname) ? undefined : hostname)
        connector({ ...options, hostname: target.address, servername }, callback)
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null),
    )
  }
}

/** A fresh undici agent whose connections pass through `guardConnector`. */
export function guardedAgent(connectOptions: buildConnector.BuildOptions = {}): Agent {
  const connector = guardConnector(buildConnector(connectOptions))
  return new Agent({ connect: connector, allowH2: connectOptions.allowH2 ?? false })
}

let sharedAgent: Agent | undefined

/**
 * `fetch` for requests to user-supplied URLs (notification webhooks, RabbitMQ nodes). With the
 * guard off this is the global `fetch` (tests stub it); with the guard on it is undici's `fetch`
 * through a guarded agent, so every connection and redirect hop is checked.
 */
export async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (!outboundGuardActive()) return fetch(input, init)
  sharedAgent ??= guardedAgent()
  let body = init.body
  // undici's fetch only recognises its own FormData class.
  if (body instanceof FormData) {
    const form = new UndiciFormData()
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') form.append(key, value)
      else form.append(key, value, value.name)
    }
    body = form as unknown as BodyInit
  }
  const response = await undiciFetch(input, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    body: body as never,
    dispatcher: sharedAgent,
  })
  return response as unknown as Response
}

/**
 * Save-time fast feedback: the reason a literal target (IP in any form the URL parser accepts, or
 * `localhost`) is denied, or `null` when it is allowed or is a name that only resolution can judge.
 */
export function literalTargetDenial(host: string | null | undefined): string | null {
  if (!host || !outboundGuardActive()) return null
  const trimmed = stripAddress(host.trim())
  if (!trimmed) return null
  const lower = trimmed.toLowerCase().replace(/\.$/, '')
  if (getAddressPolicy().denyPrivate && (lower === 'localhost' || lower.endsWith('.localhost'))) {
    if (getAddressPolicy().classify('127.0.0.1').allowed) return null
    return blockedError(trimmed, 'private').message
  }
  // The WHATWG URL parser normalises IPv4 literals like inet_aton: 2130706433, 0x7f.1, 127.1.
  let normalised = trimmed
  try {
    const bracketed = net.isIP(trimmed) === 6 ? `[${trimmed}]` : trimmed
    normalised = stripAddress(new URL(`http://${bracketed}/`).hostname)
  } catch {
    return null
  }
  const verdict = literalVerdict(normalised)
  if (!verdict || verdict.allowed) return null
  return blockedError(trimmed, verdict.reason).message
}
