/**
 * gRPC keyword monitor: parses `grpcProtobuf`, calls `grpcServiceName.grpcMethod` on `grpcUrl`
 * with the JSON `grpcBody` and checks the serialised response for `keyword` (optionally inverted).
 * `@grpc/grpc-js` and `protobufjs` are optional dependencies loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/grpc.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import type { Method } from 'protobufjs'

import type { Monitor } from '@/payload-types'
import {
  blockedLocalError,
  outboundGuardActive,
  resolveGuardedTarget,
} from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  loadOptionalDriver,
  parseJsonObject,
  requireField,
  responseExcerpt,
} from './util'

/** Response bodies longer than this are truncated in failure messages. */
const MAX_MESSAGE_RESPONSE = 50

/** Keyword verdict shared with the gRPC check: message on success, Error on mismatch. */
export function evaluateKeyword(
  response: string,
  monitor: Pick<Monitor, 'keyword' | 'invertKeyword'>,
): string {
  const keyword = monitor.keyword ?? ''
  const keywordFound = response.includes(keyword)
  if (keywordFound === Boolean(monitor.invertKeyword)) {
    const truncated =
      response.length > MAX_MESSAGE_RESPONSE
        ? `${response.substring(0, MAX_MESSAGE_RESPONSE - 3)}...`
        : response
    throw new Error(`keyword [${keyword}] is ${keywordFound ? 'present' : 'not'} in [${truncated}]`)
  }
  return `${responseExcerpt(response)}, keyword [${keyword}] ${keywordFound ? 'is' : 'not'} found`
}

/** protobufjs names service methods in lowerCamelCase; accept the proto spelling too. */
export function lcFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

type RpcCallback = (err: Error | null, response?: unknown) => void

/**
 * Outbound address guard for a gRPC target (`host:port`, `dns:host:port`, `dns:///host:port`):
 * the channel is pointed at the vetted address while TLS and `:authority` keep the original name.
 * Other resolver schemes (`unix:`, `ipv4:`, …) are refused while the guard is on.
 */
export async function pinGrpcTarget(
  url: string,
): Promise<{ target: string; channelOptions: Record<string, string> }> {
  if (!outboundGuardActive()) return { target: url, channelOptions: {} }
  let rest = url.trim()
  const scheme = rest.match(/^([a-z][a-z0-9+.-]*):/i)
  if (scheme && !/^\d+$/.test(rest.slice(scheme[0].length).split('/')[0])) {
    if (scheme[1].toLowerCase() !== 'dns') {
      throw blockedLocalError(`The gRPC target scheme "${scheme[1]}:"`)
    }
    rest = rest.slice(scheme[0].length).replace(/^\/\/[^/]*\//, '')
  }
  let host: string
  let port = '443'
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    host = rest.slice(1, end)
    if (rest[end + 1] === ':') port = rest.slice(end + 2)
  } else {
    const colon = rest.lastIndexOf(':')
    host = colon === -1 ? rest : rest.slice(0, colon)
    if (colon !== -1) port = rest.slice(colon + 1)
  }
  const vetted = await resolveGuardedTarget(host)
  if (!vetted || vetted.address === host) return { target: url, channelOptions: {} }
  const address = vetted.family === 6 ? `[${vetted.address}]` : vetted.address
  const authority = port === '443' ? host : `${host}:${port}`
  return {
    target: `${address}:${port}`,
    channelOptions: {
      'grpc.ssl_target_name_override': host,
      'grpc.default_authority': authority,
    },
  }
}

/** Perform the unary call and resolve with the JSON-serialised response. */
export async function grpcQuery(
  monitor: Pick<
    Monitor,
    | 'grpcUrl'
    | 'grpcProtobuf'
    | 'grpcServiceName'
    | 'grpcMethod'
    | 'grpcEnableTls'
    | 'grpcBody'
    | 'grpcMetadata'
  >,
  timeoutMs: number,
): Promise<string> {
  const url = requireField(monitor.grpcUrl, 'gRPC URL')
  const protobufText = requireField(monitor.grpcProtobuf, 'Proto definition')
  const serviceName = requireField(monitor.grpcServiceName, 'Service name')
  const methodName = requireField(monitor.grpcMethod, 'Method')
  const body = monitor.grpcBody?.trim() ? parseJsonObject(monitor.grpcBody, 'Request body') : {}
  const metadataEntries = parseJsonObject(monitor.grpcMetadata, 'Metadata')

  const grpc = await loadOptionalDriver(() => import('@grpc/grpc-js'), '@grpc/grpc-js', 'gRPC')
  const protobuf = await loadOptionalDriver(() => import('protobufjs'), 'protobufjs', 'gRPC')

  const root = protobuf.parse(protobufText).root
  const service = root.lookupService(serviceName)
  const Client = grpc.makeGenericClientConstructor({}, serviceName)
  const credentials = monitor.grpcEnableTls
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure()
  const { target, channelOptions } = await pinGrpcTarget(url)
  const client = new Client(target, credentials, channelOptions)
  const metadata = new grpc.Metadata()
  for (const [key, value] of Object.entries(metadataEntries)) metadata.add(key, String(value))

  const rpc = service.create(
    (method, requestData, callback) => {
      // ".pkg.Service.Method" → "/pkg.Service/Method"
      const parts = (method as Method).fullName.split('.')
      const name = parts.pop()
      const path = `/${parts.slice(1).join('.')}/${name}`
      client.makeUnaryRequest(
        path,
        (arg: Buffer) => arg,
        (arg: Buffer) => arg,
        Buffer.from(requestData),
        metadata,
        { deadline: Date.now() + timeoutMs },
        callback as RpcCallback,
      )
    },
    false,
    false,
  ) as unknown as Record<string, (body: unknown, cb: RpcCallback) => void>

  const call = rpc[methodName] ?? rpc[lcFirst(methodName)]
  if (typeof call !== 'function') {
    const available = service.methodsArray.map((m) => lcFirst(m.name)).join(', ')
    client.close()
    throw new Error(`Method "${methodName}" not found in service ${serviceName} (${available})`)
  }

  try {
    return await new Promise<string>((resolve, reject) => {
      // protobufjs service methods rely on `this` being the rpc service.
      call.call(rpc, body, (err, response) => {
        if (err) {
          const status = err as Error & { code?: number; details?: string }
          // CANCELLED (1) is considered OK, as in Uptime Kuma.
          if (status.code !== 1) return reject(err)
          return resolve(`${status.code} is considered OK because ${status.details}`)
        }
        resolve(JSON.stringify(response))
      })
    })
  } finally {
    client.close()
  }
}

registerMonitorType({
  name: 'grpc-keyword',
  label: 'gRPC(s) - Keyword',
  group: 'specific',
  async check(ctx) {
    const startTime = Date.now()
    const response = await grpcQuery(ctx.monitor, checkTimeoutMs(ctx.monitor))
    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.msg = evaluateKeyword(response, ctx.monitor)
    ctx.heartbeat.status = 'up'
  },
})
