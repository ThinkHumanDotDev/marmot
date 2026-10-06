/**
 * Docker container monitor: UP while the container runs (and is healthy when it has a health check).
 * Ported from the `docker` branch of Uptime Kuma 3.0.0-beta.0 `server/model/monitor.js` —
 * Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */
import type { DockerHost } from '@/payload-types'
import { containerVerdict, dockerRequest, type DockerContainerState } from '@/server/docker/client'
import { registerMonitorType } from './registry'

registerMonitorType({
  name: 'docker',
  label: 'Docker Container',
  group: 'specific',
  allowCustomStatus: true,
  async check(ctx) {
    const { monitor } = ctx
    const container = monitor.dockerContainer?.trim().replace(/^\//, '')
    if (!container) throw new Error('Container name or id is required')

    const ref = monitor.dockerHost
    if (ref === null || ref === undefined) throw new Error('No Docker host selected')
    const host =
      typeof ref === 'object'
        ? ref
        : ((await ctx.payload
            .findByID({ collection: 'docker-hosts', id: ref, depth: 0, overrideAccess: true })
            .catch(() => null)) as DockerHost | null)
    if (!host) throw new Error('Failed to load docker host config')

    const data = await dockerRequest<{ State?: DockerContainerState }>(
      host,
      `/containers/${encodeURIComponent(container)}/json`,
      ctx.signal,
    )
    const verdict = containerVerdict(data.State)
    if (verdict.status === 'down') throw new Error(verdict.msg)
    ctx.heartbeat.status = verdict.status
    ctx.heartbeat.msg = verdict.msg
  },
})
