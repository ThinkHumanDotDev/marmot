import * as migration_20261011_141735_ct_alerts from './20261011_141735_ct_alerts'

export const migrations = [
  {
    up: migration_20261011_141735_ct_alerts.up,
    down: migration_20261011_141735_ct_alerts.down,
    name: '20261011_141735_ct_alerts',
  },
]
