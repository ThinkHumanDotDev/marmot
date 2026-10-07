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
import * as migration_20261007_032404_incident_timeline from './20261007_032404_incident_timeline';

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
    up: migration_20261007_032404_incident_timeline.up,
    down: migration_20261007_032404_incident_timeline.down,
    name: '20261007_032404_incident_timeline'
  },
];
