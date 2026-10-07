/** Inputs of the Marmot GitHub Action (`action/action.yml`), validated. */
import { t } from '../cli/text'
import { getInput, type Env } from './github'

export type Mode = 'run' | 'apply'

export interface ActionInputs {
  url: string
  apiKey: string
  org: string
  mode: Mode
  /** Monitor keys or ids (`12` / `#12`) to check in `run` mode. */
  monitors: string[]
  /** Monitors file: what `apply` applies, and the monitors `run` checks when `monitors` is empty. */
  config: string | null
  failOnDegraded: boolean
  dryRun: boolean
  /** Why `dryRun` is on when the input was `auto` (the event name), else `null`. */
  dryRunEvent: string | null
  prune: boolean
}

/** Thrown for invalid inputs; the action reports the message and fails. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

/** Events where `dry-run: auto` only plans: the change is not merged yet. */
export const DRY_RUN_EVENTS: readonly string[] = [
  'pull_request',
  'pull_request_target',
  'merge_group',
]

/** Keys or ids separated by newlines, commas or spaces. */
export const parseList = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)

function booleanInput(env: Env, name: string, fallback: boolean): boolean {
  const raw = getInput(env, name).toLowerCase()
  if (raw === '') return fallback
  if (['true', 'yes', '1', 'on'].includes(raw)) return true
  if (['false', 'no', '0', 'off'].includes(raw)) return false
  throw new InputError(t('action.booleanInvalid', { name }))
}

/** Connection input, else the variable the CLI reads (so `env:` blocks work for both). */
function connectionInput(env: Env, name: string, variable: string): string {
  const value = getInput(env, name) || (env[variable] ?? '').trim()
  if (!value) throw new InputError(t('action.inputMissing', { name, env: variable }))
  return value
}

export function readInputs(env: Env): ActionInputs {
  const modeRaw = (getInput(env, 'mode') || 'run').toLowerCase()
  if (modeRaw !== 'run' && modeRaw !== 'apply') {
    throw new InputError(t('action.modeInvalid', { mode: modeRaw }))
  }
  const mode: Mode = modeRaw
  const monitors = parseList(getInput(env, 'monitors'))
  const config = getInput(env, 'config') || null

  const dryRunRaw = (getInput(env, 'dry-run') || 'auto').toLowerCase()
  let dryRun: boolean
  let dryRunEvent: string | null = null
  if (dryRunRaw === 'auto') {
    const event = env.GITHUB_EVENT_NAME ?? ''
    dryRun = DRY_RUN_EVENTS.includes(event)
    if (dryRun) dryRunEvent = event
  } else if (['true', 'false'].includes(dryRunRaw)) {
    dryRun = dryRunRaw === 'true'
  } else {
    throw new InputError(t('action.dryRunInvalid'))
  }

  if (mode === 'run' && monitors.length === 0 && !config) {
    throw new InputError(t('action.noTargets'))
  }
  if (mode === 'apply' && !config) throw new InputError(t('action.configRequired'))

  return {
    url: connectionInput(env, 'url', 'MARMOT_URL'),
    apiKey: connectionInput(env, 'api-key', 'MARMOT_API_KEY'),
    org: connectionInput(env, 'org', 'MARMOT_ORG'),
    mode,
    monitors,
    config,
    failOnDegraded: booleanInput(env, 'fail-on-degraded', false),
    dryRun,
    dryRunEvent,
    prune: booleanInput(env, 'prune', false),
  }
}
