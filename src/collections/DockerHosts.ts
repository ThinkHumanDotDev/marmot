import { ValidationError, type CollectionBeforeValidateHook, type CollectionConfig } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { env } from '@/env'
import {
  DEFAULT_DOCKER_SOCKET,
  DOCKER_CONNECTION_TYPES,
  DOCKER_URL_PATTERN,
} from '@/lib/monitor-resources'
import type { DockerHost } from '@/payload-types'
import {
  blockedLocalError,
  hostLocalChecksRefused,
  literalTargetDenial,
} from '@/server/security/outbound-guard'
import { looseHost } from '@/server/security/monitor-targets'

import { detachMonitorRelation } from './shared'

/**
 * A socket host needs a path (and socket hosts must be enabled on the instance), a TCP host a
 * `tcp://` / `http(s)://` URL. The unused field is cleared so the document says what it does.
 */
const validateConnection: CollectionBeforeValidateHook<DockerHost> = ({ data, originalDoc }) => {
  if (!data) return data
  const connectionType = data.connectionType ?? originalDoc?.connectionType ?? 'socket'
  const fail = (path: string, message: string) => {
    throw new ValidationError({ collection: 'docker-hosts', errors: [{ message, path }] })
  }
  if (typeof data.name === 'string') data.name = data.name.trim()

  if (connectionType === 'socket') {
    if (!env.DOCKER_SOCKET_ENABLED) {
      fail(
        'connectionType',
        'Socket connections are disabled on this instance (DOCKER_SOCKET_ENABLED).',
      )
    }
    if (hostLocalChecksRefused()) {
      fail('connectionType', blockedLocalError('A Docker socket host').message)
    }
    const socketPath = (data.socketPath ?? originalDoc?.socketPath ?? '').trim()
    if (!socketPath.startsWith('/')) fail('socketPath', 'Enter an absolute socket path.')
    data.socketPath = socketPath
    data.url = null
  } else {
    const url = (data.url ?? originalDoc?.url ?? '').trim()
    if (!DOCKER_URL_PATTERN.test(url)) {
      fail('url', 'Enter the daemon URL, e.g. tcp://docker.example.com:2375.')
    }
    const denial = literalTargetDenial(looseHost(url))
    if (denial) fail('url', denial)
    data.url = url
    data.socketPath = null
  }
  return data
}

export const DockerHosts: CollectionConfig = {
  slug: 'docker-hosts',
  admin: {
    useAsTitle: 'name',
    group: 'Monitoring',
    defaultColumns: ['name', 'connectionType', 'socketPath', 'url'],
  },
  // Members read (to pick a host for their monitors), admins write: a Docker host reaches a daemon.
  access: {
    read: orgScoped('docker-host:read'),
    create: orgScoped('docker-host:create'),
    update: orgScoped('docker-host:update'),
    delete: orgScoped('docker-host:delete'),
  },
  hooks: {
    beforeValidate: [validateConnection],
    beforeDelete: [detachMonitorRelation('dockerHost')],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: 150 },
    {
      name: 'connectionType',
      type: 'select',
      required: true,
      defaultValue: 'socket',
      options: DOCKER_CONNECTION_TYPES.map((value) => ({
        label: value === 'socket' ? 'Socket' : 'TCP / HTTP',
        value,
      })),
    },
    {
      name: 'socketPath',
      type: 'text',
      defaultValue: DEFAULT_DOCKER_SOCKET,
      maxLength: 1024,
      admin: {
        condition: (data) => data?.connectionType !== 'tcp',
        description: 'Unix socket of the Docker daemon, as seen by the worker.',
      },
    },
    {
      name: 'url',
      type: 'text',
      maxLength: 2048,
      admin: {
        condition: (data) => data?.connectionType === 'tcp',
        placeholder: 'tcp://docker.example.com:2375',
        description: 'tcp:// and http:// connect in plain text; https:// uses TLS.',
      },
    },
  ],
  timestamps: true,
}
