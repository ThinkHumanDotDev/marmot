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
    name: '20261005_222624_settings_2fa_permissions'
  },
];
