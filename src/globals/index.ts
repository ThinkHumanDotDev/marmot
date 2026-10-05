import type { GlobalConfig } from 'payload'

import { InstanceSettings } from './InstanceSettings'

/** Registry of every Payload global. Add new globals here (one import + one entry). */
export const globals: GlobalConfig[] = [InstanceSettings]
