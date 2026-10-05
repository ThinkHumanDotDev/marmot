import type { MonitorType } from './types'

/**
 * Monitor type registry. Kept apart from `index.ts` so the built-in type modules can import
 * `registerMonitorType` without a circular dependency on the module that imports them.
 */
const registry = new Map<string, MonitorType>()

/** Register a monitor type. Called once per type at module load. */
export function registerMonitorType(type: MonitorType): void {
  if (registry.has(type.name)) {
    throw new Error(`Monitor type "${type.name}" is already registered`)
  }
  registry.set(type.name, type)
}

export function getMonitorType(name: string): MonitorType | undefined {
  return registry.get(name)
}

export function listMonitorTypes(): MonitorType[] {
  return [...registry.values()]
}
