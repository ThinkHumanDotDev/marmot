import type { CollectionConfig } from 'payload'

import { Invitations } from './Invitations'
import { Media } from './Media'
import { Monitors } from './Monitors'
import { Organizations } from './Organizations'
import { StatDaily } from './StatDaily'
import { StatHourly } from './StatHourly'
import { StatMinutely } from './StatMinutely'
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
  StatMinutely,
  StatHourly,
  StatDaily,
]
