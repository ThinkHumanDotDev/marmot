/**
 * Save-time checks of the outbound address guard for monitors: refuse host-local types while
 * private addresses are denied, and refuse targets that are denied literally (an IP in any form,
 * `localhost`). This is fast feedback only; names are judged when the check connects
 * (see `outbound-guard.ts`), which is the actual protection.
 */
import type { PayloadRequest } from 'payload'

import type { DockerHost, Monitor } from '@/payload-types'

import { connectionStringDenial } from './connection-hosts'
import {
  blockedLocalError,
  hostLocalChecksRefused,
  literalTargetDenial,
  outboundGuardActive,
} from './outbound-guard'

/** Fields that decide where a monitor connects; changing any of them re-runs the check. */
export const MONITOR_TARGET_FIELDS = [
  'type',
  'url',
  'hostname',
  'dnsResolveServer',
  'databaseConnectionString',
  'kafkaProducerBrokers',
  'rabbitmqNodes',
  'grpcUrl',
  'dockerHost',
  'oauthTokenUrl',
  'authMethod',
] as const

/** Monitor types that reach the network past the guard; refused while it denies private ranges. */
export const HOST_LOCAL_MONITOR_TYPES: Record<string, string> = {
  'tailscale-ping': 'The Tailscale Ping monitor',
  'real-browser': 'The Browser Engine monitor',
}

export interface MonitorTargetProblem {
  path: string
  message: string
}

/** Host of `value`, which may be a URL (`mqtt://h:1883`), `host:port`, `[v6]:port` or a bare host. */
export function looseHost(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
    return url.hostname.replace(/^\[|\]$/g, '') || null
  } catch {
    // A bare IPv6 address (`::1`) is no valid authority without brackets.
    return trimmed
  }
}

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return (value as { id?: string | number }).id ?? null
  return value as string | number
}

/** The first reason `monitor` may not be saved under the guard, or null. */
export async function monitorTargetProblem(
  monitor: Partial<Monitor>,
  req?: PayloadRequest,
): Promise<MonitorTargetProblem | null> {
  if (!outboundGuardActive()) return null
  const type = monitor.type ?? 'http'

  if (hostLocalChecksRefused() && HOST_LOCAL_MONITOR_TYPES[type]) {
    return { path: 'type', message: blockedLocalError(HOST_LOCAL_MONITOR_TYPES[type]).message }
  }

  const literal = (path: string, host: string | null | undefined): MonitorTargetProblem | null => {
    const message = literalTargetDenial(host)
    return message ? { path, message } : null
  }

  switch (type) {
    // The worker only talks to api.globalping.io; the target is measured by remote community
    // probes (and Globalping refuses private targets itself).
    case 'globalping':
      return null
    case 'http':
    case 'keyword':
    case 'json-query':
    case 'websocket-upgrade':
    case 'real-browser': {
      const problem = literal('url', looseHost(monitor.url))
      if (problem) return problem
      if (monitor.authMethod === 'oauth2-cc') {
        return literal('oauthTokenUrl', looseHost(monitor.oauthTokenUrl))
      }
      return null
    }
    case 'dns':
      for (const server of (monitor.dnsResolveServer ?? '').split(',')) {
        const problem = literal('dnsResolveServer', server.trim() || null)
        if (problem) return problem
      }
      return null
    case 'mysql':
    case 'postgres':
    case 'sqlserver':
    case 'mongodb':
    case 'redis': {
      const message = connectionStringDenial(monitor.databaseConnectionString)
      return message ? { path: 'databaseConnectionString', message } : null
    }
    case 'kafka-producer':
      for (const broker of monitor.kafkaProducerBrokers ?? []) {
        const problem = literal('kafkaProducerBrokers', looseHost(broker))
        if (problem) return problem
      }
      return null
    case 'rabbitmq':
      for (const node of monitor.rabbitmqNodes ?? []) {
        const problem = literal('rabbitmqNodes', looseHost(node))
        if (problem) return problem
      }
      return null
    case 'grpc-keyword':
      return literal('grpcUrl', looseHost(monitor.grpcUrl?.replace(/^dns:(\/\/[^/]*\/)?/i, '')))
    case 'docker': {
      const id = relationId(monitor.dockerHost)
      if (id === null || !req) return null
      const host = (await req.payload
        .findByID({ collection: 'docker-hosts', id, depth: 0, overrideAccess: true, req })
        .catch(() => null)) as DockerHost | null
      if (!host) return null
      if (host.connectionType !== 'tcp') {
        return hostLocalChecksRefused()
          ? { path: 'dockerHost', message: blockedLocalError('A Docker socket host').message }
          : null
      }
      return literal('dockerHost', looseHost(host.url))
    }
    default:
      return literal('hostname', looseHost(monitor.hostname))
  }
}
