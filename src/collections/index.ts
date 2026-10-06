import type { CollectionConfig } from 'payload'

import { ApiKeys } from './ApiKeys'
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
import { StatDaily } from './StatDaily'
import { StatHourly } from './StatHourly'
import { StatMinutely } from './StatMinutely'
import { StatusPages } from './StatusPages'
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
  NotificationSentHistory,
  Heartbeats,
  StatMinutely,
  StatHourly,
  StatDaily,
  StatusPages,
  Incidents,
  Maintenance,
  ApiKeys,
  AuditLogs,
]
