import * as migration_20261005_012756_initial from './20261005_012756_initial';
import * as migration_20261005_020303_add_stats from './20261005_020303_add_stats';
import * as migration_20261005_023021_organizations_rbac from './20261005_023021_organizations_rbac';

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
    name: '20261005_023021_organizations_rbac'
  },
];
