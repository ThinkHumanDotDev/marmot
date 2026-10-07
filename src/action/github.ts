/**
 * The parts of the GitHub Actions runner protocol the Marmot action (#118) uses: inputs from
 * `INPUT_*`, outputs and the job summary through the files the runner names, and workflow commands
 * (annotations, masking) on stdout. Implemented here instead of depending on `@actions/core` so the
 * bundle stays small and the logic stays testable without a runner.
 */
import { randomUUID } from 'node:crypto'

export type Env = Record<string, string | undefined>

/** What the action touches outside itself, so tests run it in-process. */
export interface ActionIo {
  env: Env
  stdout(text: string): void
  readFile(path: string): Promise<string>
  appendFile(path: string, text: string): Promise<void>
  fetch?: typeof fetch
  sleep(ms: number): Promise<void>
}

/** An input as the runner passes it: `INPUT_<NAME>` with spaces as `_`, upper case, trimmed. */
export function getInput(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim()
}

/** Escapes data for a workflow command (`::error::<data>`). */
export function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** Escapes a property value of a workflow command (`::error title=<value>::`). */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

export function annotation(level: 'error' | 'warning' | 'notice', message: string, title?: string) {
  const props = title ? ` title=${escapeProperty(title)}` : ''
  return `::${level}${props}::${escapeData(message)}\n`
}

export const mask = (value: string) => `::add-mask::${escapeData(value)}\n`

/** `name<<delimiter` block for `$GITHUB_OUTPUT` (safe for multi-line values). */
export function outputBlock(
  name: string,
  value: string,
  delimiter = `ghadelimiter_${randomUUID()}`,
) {
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`
}

/** Writes step outputs; outside a runner (no `GITHUB_OUTPUT`) they are dropped. */
export async function setOutputs(io: ActionIo, outputs: Record<string, string>): Promise<void> {
  const file = io.env.GITHUB_OUTPUT
  if (!file) return
  const text = Object.entries(outputs)
    .map(([name, value]) => outputBlock(name, value))
    .join('')
  await io.appendFile(file, text)
}

/** Appends Markdown to the job summary; outside a runner it goes to stdout. */
export async function writeSummary(io: ActionIo, markdown: string): Promise<void> {
  const file = io.env.GITHUB_STEP_SUMMARY
  const text = markdown.endsWith('\n') ? markdown : `${markdown}\n`
  if (file) await io.appendFile(file, text)
  else io.stdout(text)
}
