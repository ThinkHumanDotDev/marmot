/**
 * Where the CLI finds the instance URL, the API key and the organization: command-line flags, then
 * `MARMOT_URL` / `MARMOT_API_KEY` / `MARMOT_ORG`, then the profile saved by `marmot login` in
 * `$MARMOT_CONFIG` (default `$XDG_CONFIG_HOME/marmot/config.json`, `~/.config/marmot/config.json`).
 * The CLI is a client program, not part of the server, so it reads its own variables (passed in by
 * the entry point) rather than `src/env.ts`.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export interface Profile {
  url?: string
  apiKey?: string
  org?: string
}

export interface ConfigFile {
  currentProfile?: string
  profiles: Record<string, Profile>
}

export type Env = Record<string, string | undefined>

export const DEFAULT_PROFILE = 'default'

export function configPath(env: Env): string {
  if (env.MARMOT_CONFIG) return env.MARMOT_CONFIG
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config')
  return path.join(base, 'marmot', 'config.json')
}

export async function readConfigFile(file: string): Promise<ConfigFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { profiles: {} }
  }
  const parsed = JSON.parse(text) as Partial<ConfigFile>
  return { currentProfile: parsed.currentProfile, profiles: parsed.profiles ?? {} }
}

/** Writes the file readable by the owner only: it holds API keys. */
export async function writeConfigFile(file: string, config: ConfigFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

export interface Connection {
  url: string | null
  apiKey: string | null
  org: string | null
  profile: string
}

export interface ConnectionFlags {
  url?: string
  apiKey?: string
  org?: string
  profile?: string
}

export function resolveConnection(
  flags: ConnectionFlags,
  env: Env,
  config: ConfigFile,
): Connection {
  const profile = flags.profile || env.MARMOT_PROFILE || config.currentProfile || DEFAULT_PROFILE
  const saved = config.profiles[profile] ?? {}
  return {
    url: flags.url || env.MARMOT_URL || saved.url || null,
    apiKey: flags.apiKey || env.MARMOT_API_KEY || saved.apiKey || null,
    org: flags.org || env.MARMOT_ORG || saved.org || null,
    profile,
  }
}

/** `mk_abcd…wxyz` for display. */
export const maskKey = (key: string | null): string | null =>
  key === null ? null : key.length <= 12 ? '…' : `${key.slice(0, 7)}…${key.slice(-4)}`
