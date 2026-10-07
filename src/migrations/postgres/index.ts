import * as migration_20261005_012756_initial from './20261005_012756_initial';
import * as migration_20261005_020303_add_stats from './20261005_020303_add_stats';
import * as migration_20261005_023021_organizations_rbac from './20261005_023021_organizations_rbac';
import * as migration_20261005_023920_monitors_heartbeats from './20261005_023920_monitors_heartbeats';
import * as migration_20261005_030513_add_oidc_fields from './20261005_030513_add_oidc_fields';
import * as migration_20261005_032603_instance_settings from './20261005_032603_instance_settings';
import * as migration_20261005_033951_add_invite_link from './20261005_033951_add_invite_link';
import * as migration_20261005_042854_monitors_org_scoped from './20261005_042854_monitors_org_scoped';
import * as migration_20261005_045549_notifications from './20261005_045549_notifications';
import * as migration_20261005_051201_status_pages from './20261005_051201_status_pages';
import * as migration_20261005_133533_billing from './20261005_133533_billing';
import * as migration_20261005_222624_settings_2fa_permissions from './20261005_222624_settings_2fa_permissions';
import * as migration_20261005_225041_audit_logs from './20261005_225041_audit_logs';
import * as migration_20261005_233026_cert_domain_expiry from './20261005_233026_cert_domain_expiry';
import * as migration_20261005_234608_api_keys from './20261005_234608_api_keys';
import * as migration_20261006_000143_maintenance from './20261006_000143_maintenance';
import * as migration_20261006_001607_add_monitor_type_fields from './20261006_001607_add_monitor_type_fields';
import * as migration_20261006_003708_tags_proxies_docker from './20261006_003708_tags_proxies_docker';
import * as migration_20261006_135746_add_auth_accounts from './20261006_135746_add_auth_accounts';
import * as migration_20261006_141212_add_auth_provider_values from './20261006_141212_add_auth_provider_values';
import * as migration_20261006_143503_add_sso_connections from './20261006_143503_add_sso_connections';
import * as migration_20261006_144923_add_enforce_sso from './20261006_144923_add_enforce_sso';
import * as migration_20261006_212748_add_language_fields from './20261006_212748_add_language_fields';
import * as migration_20261007_021706_status_page_components from './20261007_021706_status_page_components';
import * as migration_20261007_031019_status_page_themes from './20261007_031019_status_page_themes';
import * as migration_20261007_034435_status_page_access from './20261007_034435_status_page_access';
import * as migration_20261007_063246_maintenance_announcements from './20261007_063246_maintenance_announcements';
import * as migration_20261007_065512_incident_timeline from './20261007_065512_incident_timeline';
import * as migration_20261007_075026_status_page_restricted_access from './20261007_075026_status_page_restricted_access';
import * as migration_20261007_082448_status_page_history from './20261007_082448_status_page_history';
import * as migration_20261007_085940_status_page_subscribers from './20261007_085940_status_page_subscribers';
import * as migration_20261007_094147_templates from './20261007_094147_templates';
import * as migration_20261007_103631_monitor_degraded_state from './20261007_103631_monitor_degraded_state';
import * as migration_20261007_110911_notification_event_filters from './20261007_110911_notification_event_filters';
import * as migration_20261007_140856_monitor_assertions from './20261007_140856_monitor_assertions';
import * as migration_20261007_145743_heartbeat_trigger from './20261007_145743_heartbeat_trigger';
import * as migration_20261007_160552_push_monitor_cron from './20261007_160552_push_monitor_cron';
import * as migration_20261007_163630_monitor_incidents from './20261007_163630_monitor_incidents';
import * as migration_20261007_173835_engine_recovery from './20261007_173835_engine_recovery';
import * as migration_20261007_181153_audit_log_coverage from './20261007_181153_audit_log_coverage';
import * as migration_20261007_192808_sso_group_mapping from './20261007_192808_sso_group_mapping';
import * as migration_20261007_201419_outbound_webhooks from './20261007_201419_outbound_webhooks';

export const migrations = [
  {
    up: migration_20261005_012756_initial.up,
    down: migration_20261005_012756_initial.down,
    name: '20261005_012756_initial',
  },
  {
    up: migration_20261005_020303_add_stats.up,
    down: migration_20261005_020303_add_stats.down,
    name: '20261005_020303_add_stats',
  },
  {
    up: migration_20261005_023021_organizations_rbac.up,
    down: migration_20261005_023021_organizations_rbac.down,
    name: '20261005_023021_organizations_rbac',
  },
  {
    up: migration_20261005_023920_monitors_heartbeats.up,
    down: migration_20261005_023920_monitors_heartbeats.down,
    name: '20261005_023920_monitors_heartbeats',
  },
  {
    up: migration_20261005_030513_add_oidc_fields.up,
    down: migration_20261005_030513_add_oidc_fields.down,
    name: '20261005_030513_add_oidc_fields',
  },
  {
    up: migration_20261005_032603_instance_settings.up,
    down: migration_20261005_032603_instance_settings.down,
    name: '20261005_032603_instance_settings',
  },
  {
    up: migration_20261005_033951_add_invite_link.up,
    down: migration_20261005_033951_add_invite_link.down,
    name: '20261005_033951_add_invite_link',
  },
  {
    up: migration_20261005_042854_monitors_org_scoped.up,
    down: migration_20261005_042854_monitors_org_scoped.down,
    name: '20261005_042854_monitors_org_scoped',
  },
  {
    up: migration_20261005_045549_notifications.up,
    down: migration_20261005_045549_notifications.down,
    name: '20261005_045549_notifications',
  },
  {
    up: migration_20261005_051201_status_pages.up,
    down: migration_20261005_051201_status_pages.down,
    name: '20261005_051201_status_pages',
  },
  {
    up: migration_20261005_133533_billing.up,
    down: migration_20261005_133533_billing.down,
    name: '20261005_133533_billing',
  },
  {
    up: migration_20261005_222624_settings_2fa_permissions.up,
    down: migration_20261005_222624_settings_2fa_permissions.down,
    name: '20261005_222624_settings_2fa_permissions',
  },
  {
    up: migration_20261005_225041_audit_logs.up,
    down: migration_20261005_225041_audit_logs.down,
    name: '20261005_225041_audit_logs',
  },
  {
    up: migration_20261005_233026_cert_domain_expiry.up,
    down: migration_20261005_233026_cert_domain_expiry.down,
    name: '20261005_233026_cert_domain_expiry',
  },
  {
    up: migration_20261005_234608_api_keys.up,
    down: migration_20261005_234608_api_keys.down,
    name: '20261005_234608_api_keys',
  },
  {
    up: migration_20261006_000143_maintenance.up,
    down: migration_20261006_000143_maintenance.down,
    name: '20261006_000143_maintenance',
  },
  {
    up: migration_20261006_001607_add_monitor_type_fields.up,
    down: migration_20261006_001607_add_monitor_type_fields.down,
    name: '20261006_001607_add_monitor_type_fields',
  },
  {
    up: migration_20261006_003708_tags_proxies_docker.up,
    down: migration_20261006_003708_tags_proxies_docker.down,
    name: '20261006_003708_tags_proxies_docker',
  },
  {
    up: migration_20261006_135746_add_auth_accounts.up,
    down: migration_20261006_135746_add_auth_accounts.down,
    name: '20261006_135746_add_auth_accounts',
  },
  {
    up: migration_20261006_141212_add_auth_provider_values.up,
    down: migration_20261006_141212_add_auth_provider_values.down,
    name: '20261006_141212_add_auth_provider_values',
  },
  {
    up: migration_20261006_143503_add_sso_connections.up,
    down: migration_20261006_143503_add_sso_connections.down,
    name: '20261006_143503_add_sso_connections',
  },
  {
    up: migration_20261006_144923_add_enforce_sso.up,
    down: migration_20261006_144923_add_enforce_sso.down,
    name: '20261006_144923_add_enforce_sso',
  },
  {
    up: migration_20261006_212748_add_language_fields.up,
    down: migration_20261006_212748_add_language_fields.down,
    name: '20261006_212748_add_language_fields',
  },
  {
    up: migration_20261007_021706_status_page_components.up,
    down: migration_20261007_021706_status_page_components.down,
    name: '20261007_021706_status_page_components',
  },
  {
    up: migration_20261007_031019_status_page_themes.up,
    down: migration_20261007_031019_status_page_themes.down,
    name: '20261007_031019_status_page_themes',
  },
  {
    up: migration_20261007_034435_status_page_access.up,
    down: migration_20261007_034435_status_page_access.down,
    name: '20261007_034435_status_page_access',
  },
  {
    up: migration_20261007_063246_maintenance_announcements.up,
    down: migration_20261007_063246_maintenance_announcements.down,
    name: '20261007_063246_maintenance_announcements',
  },
  {
    up: migration_20261007_065512_incident_timeline.up,
    down: migration_20261007_065512_incident_timeline.down,
    name: '20261007_065512_incident_timeline',
  },
  {
    up: migration_20261007_075026_status_page_restricted_access.up,
    down: migration_20261007_075026_status_page_restricted_access.down,
    name: '20261007_075026_status_page_restricted_access',
  },
  {
    up: migration_20261007_082448_status_page_history.up,
    down: migration_20261007_082448_status_page_history.down,
    name: '20261007_082448_status_page_history',
  },
  {
    up: migration_20261007_085940_status_page_subscribers.up,
    down: migration_20261007_085940_status_page_subscribers.down,
    name: '20261007_085940_status_page_subscribers',
  },
  {
    up: migration_20261007_094147_templates.up,
    down: migration_20261007_094147_templates.down,
    name: '20261007_094147_templates',
  },
  {
    up: migration_20261007_103631_monitor_degraded_state.up,
    down: migration_20261007_103631_monitor_degraded_state.down,
    name: '20261007_103631_monitor_degraded_state',
  },
  {
    up: migration_20261007_110911_notification_event_filters.up,
    down: migration_20261007_110911_notification_event_filters.down,
    name: '20261007_110911_notification_event_filters',
  },
  {
    up: migration_20261007_140856_monitor_assertions.up,
    down: migration_20261007_140856_monitor_assertions.down,
    name: '20261007_140856_monitor_assertions',
  },
  {
    up: migration_20261007_145743_heartbeat_trigger.up,
    down: migration_20261007_145743_heartbeat_trigger.down,
    name: '20261007_145743_heartbeat_trigger',
  },
  {
    up: migration_20261007_160552_push_monitor_cron.up,
    down: migration_20261007_160552_push_monitor_cron.down,
    name: '20261007_160552_push_monitor_cron',
  },
  {
    up: migration_20261007_163630_monitor_incidents.up,
    down: migration_20261007_163630_monitor_incidents.down,
    name: '20261007_163630_monitor_incidents',
  },
  {
    up: migration_20261007_173835_engine_recovery.up,
    down: migration_20261007_173835_engine_recovery.down,
    name: '20261007_173835_engine_recovery',
  },
  {
    up: migration_20261007_181153_audit_log_coverage.up,
    down: migration_20261007_181153_audit_log_coverage.down,
    name: '20261007_181153_audit_log_coverage',
  },
  {
    up: migration_20261007_192808_sso_group_mapping.up,
    down: migration_20261007_192808_sso_group_mapping.down,
    name: '20261007_192808_sso_group_mapping',
  },
  {
    up: migration_20261007_201419_outbound_webhooks.up,
    down: migration_20261007_201419_outbound_webhooks.down,
    name: '20261007_201419_outbound_webhooks'
  },
];
