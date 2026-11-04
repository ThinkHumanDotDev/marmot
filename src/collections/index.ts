import type { CollectionConfig } from 'payload'

import { withDemoGuards } from '@/server/demo/guards'

import { ApiKeys } from './ApiKeys'
import { withAuditHooks } from './audit'
import { AuthAccounts } from './AuthAccounts'
import { DockerHosts } from './DockerHosts'
import { AuditLogs } from './AuditLogs'
import { DeclaredIncidents } from './DeclaredIncidents'
import { Heartbeats } from './Heartbeats'
import { HostMetrics } from './HostMetrics'
import { Incidents } from './Incidents'
import { IntegrationAlerts } from './IntegrationAlerts'
import { IntegrationEvents } from './IntegrationEvents'
import { Integrations } from './Integrations'
import { Invitations } from './Invitations'
import { Locations } from './Locations'
import { Maintenance } from './Maintenance'
import { MaintenanceOccurrences } from './MaintenanceOccurrences'
import { Media } from './Media'
import { Metrics } from './Metrics'
import { MetricStats } from './MetricStats'
import { MonitorIncidents } from './MonitorIncidents'
import { MonitorLocationStates } from './MonitorLocationStates'
import { Monitors } from './Monitors'
import { Notifications } from './Notifications'
import { EscalationPolicies, OnCallSchedules } from './OnCall'
import { NotificationSentHistory } from './NotificationSentHistory'
import { Organizations } from './Organizations'
import { OtelCollectors } from './OtelCollectors'
import { Proxies } from './Proxies'
import { PushEvents } from './PushEvents'
import { SlaReportShares, SlaReports, SlaTargets } from './Sla'
import { SshTunnels } from './SshTunnels'
import { SsoConnections } from './SsoConnections'
import { SsoDomains } from './SsoDomains'
import { StatDaily } from './StatDaily'
import { StatHourly } from './StatHourly'
import { StatLocationHourly } from './StatLocationHourly'
import { StatMinutely } from './StatMinutely'
import { StatusPages } from './StatusPages'
import { StatusPageSubscribers } from './StatusPageSubscribers'
import { SubscriberDeliveries } from './SubscriberDeliveries'
import { SubscriberNotifications } from './SubscriberNotifications'
import { StatusPageUptimeHistory } from './StatusPageUptimeHistory'
import { StatusPageViewers } from './StatusPageViewers'
import { StatusPageAudiences } from './StatusPageAudiences'
import { Tags } from './Tags'
import { Templates } from './Templates'
import { Users } from './Users'
import { WebhookDeliveries } from './WebhookDeliveries'
import { WebhookEndpoints } from './WebhookEndpoints'

/**
 * Registry of every Payload collection. Add new collections here (one import + one entry) and
 * decide whether it is audited (`./audit.ts`). Keep the order stable: it drives the admin sidebar.
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
  SshTunnels,
  Locations,
  NotificationSentHistory,
  Heartbeats,
  MonitorIncidents,
  DeclaredIncidents,
  Integrations,
  IntegrationAlerts,
  IntegrationEvents,
  OnCallSchedules,
  EscalationPolicies,
  MonitorLocationStates,
  PushEvents,
  StatMinutely,
  StatHourly,
  StatDaily,
  StatLocationHourly,
  StatusPages,
  StatusPageViewers,
  StatusPageAudiences,
  StatusPageUptimeHistory,
  SlaTargets,
  SlaReports,
  SlaReportShares,
  Incidents,
  StatusPageSubscribers,
  SubscriberNotifications,
  SubscriberDeliveries,
  Maintenance,
  MaintenanceOccurrences,
  Templates,
  ApiKeys,
  AuditLogs,
  WebhookEndpoints,
  WebhookDeliveries,
  OtelCollectors,
  Metrics,
  MetricStats,
  HostMetrics,
]
  .map(withAuditHooks)
  // Demo mode guard rails (#159): no-ops unless DEMO_MODE is set.
  .map(withDemoGuards)
