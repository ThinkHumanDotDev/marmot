import type { CollectionConfig } from 'payload'

import { DockerHosts } from './DockerHosts'
import { AuditLogs } from './AuditLogs'
import { Heartbeats } from './Heartbeats'
import { Incidents } from './Incidents'
import { Invitations } from './Invitations'
import { Media } from './Media'
import { Monitors } from './Monitors'
import { Notifications } from './Notifications'
import { Organizations } from './Organizations'
import { Proxies } from './Proxies'
import { StatDaily } from './StatDaily'
import { StatHourly } from './StatHourly'
import { StatMinutely } from './StatMinutely'
import { StatusPages } from './StatusPages'
import { Tags } from './Tags'
import { Users } from './Users'

/**
 * Registry of every Payload collection. Add new collections here (one import + one entry).
 * Keep the order stable: it drives the admin sidebar.
 */
export const collections: CollectionConfig[] = [
  Users,
  Organizations,
  Invitations,
  Media,
  Monitors,
  Notifications,
  Tags,
  Proxies,
  DockerHosts,
  Heartbeats,
  StatMinutely,
  StatHourly,
  StatDaily,
  StatusPages,
  Incidents,
  AuditLogs,
]
