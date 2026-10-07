import type { CollectionConfig } from 'payload'

import { ApiKeys } from './ApiKeys'
import { AuthAccounts } from './AuthAccounts'
import { DockerHosts } from './DockerHosts'
import { AuditLogs } from './AuditLogs'
import { Heartbeats } from './Heartbeats'
import { Incidents } from './Incidents'
import { Invitations } from './Invitations'
import { Maintenance } from './Maintenance'
import { Media } from './Media'
import { Monitors } from './Monitors'
import { Notifications } from './Notifications'
import { NotificationSentHistory } from './NotificationSentHistory'
import { Organizations } from './Organizations'
import { Proxies } from './Proxies'
import { SsoConnections } from './SsoConnections'
import { SsoDomains } from './SsoDomains'
import { StatDaily } from './StatDaily'
import { StatHourly } from './StatHourly'
import { StatMinutely } from './StatMinutely'
import { StatusPages } from './StatusPages'
import { Tags } from './Tags'
import { Templates } from './Templates'
import { Users } from './Users'

/**
 * Registry of every Payload collection. Add new collections here (one import + one entry).
 * Keep the order stable: it drives the admin sidebar.
 */
export const collections: CollectionConfig[] = [
  Users,
  AuthAccounts,
  Organizations,
  SsoConnections,
  SsoDomains,
  Invitations,
  Media,
  Monitors,
  Notifications,
  Tags,
  Proxies,
  DockerHosts,
  NotificationSentHistory,
  Heartbeats,
  StatMinutely,
  StatHourly,
  StatDaily,
  StatusPages,
  Incidents,
  Maintenance,
  Templates,
  ApiKeys,
  AuditLogs,
]
