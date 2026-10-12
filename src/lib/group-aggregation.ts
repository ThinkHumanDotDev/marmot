/**
 * Group monitor aggregation (#144): how a group monitor turns its children's last status into its
 * own. Pure (no Payload, no I/O) so the modes are unit-tested and shared by the group check, the
 * validation schema and the monitor form.
 *
 * - `worst` (default): the worst child decides (down > pending > degraded > up), the behaviour
 *   every group had before #144.
 * - `quorum`: DOWN only when fewer than the required number (or percentage) of children are up;
 *   otherwise UP, or DEGRADED while some children are not up.
 * - `weighted`: each child has a weight (normalised so the weights sum to 1) and scores up = 1,
 *   degraded = 0.5, down = 0. A score of 1 is UP, 0 is DOWN, anything between is DEGRADED.
 *
 * Children in maintenance count as up in every mode; paused children are ignored. A child without a
 * beat yet, or pending (retrying), is unknown: `worst` is PENDING while one is, `quorum` is PENDING
 * when the unknown children decide whether the quorum is met, and `weighted` scores the known
 * children only (PENDING when there are none).
 *
 * The `worst` mode is ported from Uptime Kuma 2.5.5 `server/monitor-types/group.js` — Copyright (c)
 * 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */

export const GROUP_AGGREGATION_MODES = ['worst', 'quorum', 'weighted'] as const
export type GroupAggregationMode = (typeof GROUP_AGGREGATION_MODES)[number]
export const DEFAULT_GROUP_AGGREGATION: GroupAggregationMode = 'worst'

export const GROUP_QUORUM_UNITS = ['count', 'percent'] as const
export type GroupQuorumUnit = (typeof GROUP_QUORUM_UNITS)[number]

export const GROUP_LATENCY_MODES = ['none', 'avg', 'max', 'min'] as const
export type GroupLatencyMode = (typeof GROUP_LATENCY_MODES)[number]

/** Weight of a child that has none set. */
export const DEFAULT_GROUP_WEIGHT = 1
/** Largest weight a child may have (weights are relative, so this only bounds the input). */
export const MAX_GROUP_WEIGHT = 1000
/** Largest quorum a group may require (children, or 100 for a percentage). */
export const MAX_GROUP_QUORUM = 1000

export type ChildStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded'

export interface GroupChild {
  name: string
  /** Last status of the child; `null` before its first beat. */
  status: ChildStatus | null
  /** Paused children are ignored. */
  active: boolean
  /** Relative weight (`weighted` mode); `null` means {@link DEFAULT_GROUP_WEIGHT}. */
  weight?: number | null
  /** Last ping of the child, for the group latency. */
  ping?: number | null
}

export interface GroupAggregationSettings {
  mode?: GroupAggregationMode | null
  /** `quorum`: children (or percent of children) that must be up. */
  quorum?: number | null
  quorumUnit?: GroupQuorumUnit | null
  latency?: GroupLatencyMode | null
}

export type GroupStatus = 'up' | 'degraded' | 'pending' | 'down'

export interface GroupVerdict {
  status: GroupStatus
  /** Human-readable reason, listing the failing children. */
  msg: string
  /** Group latency from the children's ping (`latency` setting), or `null`. */
  ping: number | null
  /** `weighted` mode: the score in [0, 1]. */
  score?: number
}

const ok = (status: ChildStatus | null) => status === 'up' || status === 'maintenance'
const list = (names: readonly string[]) => names.join(', ')

/** Children (in the requested unit) that must be up for a quorum group of `total` children. */
export function requiredUp(
  total: number,
  quorum: number | null | undefined,
  unit: GroupQuorumUnit | null | undefined,
): number {
  const value = Math.max(0, Number(quorum ?? 0) || 0)
  const needed = unit === 'percent' ? Math.ceil((Math.min(value, 100) / 100) * total - 1e-9) : value
  return Math.min(total, Math.max(1, Math.ceil(needed)))
}

/** The group latency from the children's last ping, or `null` (`none`, or no child has one). */
export function groupLatency(
  children: readonly GroupChild[],
  mode: GroupLatencyMode | null | undefined,
): number | null {
  if (!mode || mode === 'none') return null
  const pings = children
    .filter((child) => child.active)
    .map((child) => child.ping)
    .filter((ping): ping is number => typeof ping === 'number' && Number.isFinite(ping))
  if (pings.length === 0) return null
  if (mode === 'max') return Math.max(...pings)
  if (mode === 'min') return Math.min(...pings)
  return Math.round(pings.reduce((sum, ping) => sum + ping, 0) / pings.length)
}

/** Weighted score of the scored children in [0, 1], or `null` when none can be scored. */
export function weightedScore(children: readonly GroupChild[]): number | null {
  const scored = children.filter(
    (child) => child.active && child.status !== null && child.status !== 'pending',
  )
  if (scored.length === 0) return null
  const weights = scored.map((child) => {
    const weight = child.weight ?? DEFAULT_GROUP_WEIGHT
    return Number.isFinite(weight) && weight > 0 ? weight : 0
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  // All weights zero: every child counts the same.
  const normalised =
    total > 0 ? weights.map((w) => w / total) : weights.map(() => 1 / scored.length)
  let score = 0
  scored.forEach((child, index) => {
    const value = ok(child.status) ? 1 : child.status === 'degraded' ? 0.5 : 0
    score += normalised[index] * value
  })
  // Floating point: 0.1 + 0.2 + 0.7 must still be exactly UP.
  return Math.min(1, Math.max(0, Math.round(score * 1e6) / 1e6))
}

interface Buckets {
  active: GroupChild[]
  up: string[]
  degraded: string[]
  pending: string[]
  down: string[]
}

function bucket(children: readonly GroupChild[]): Buckets {
  const out: Buckets = { active: [], up: [], degraded: [], pending: [], down: [] }
  for (const child of children) {
    if (!child.active) continue
    out.active.push(child)
    if (ok(child.status)) out.up.push(child.name)
    else if (child.status === 'degraded') out.degraded.push(child.name)
    else if (child.status === 'down') out.down.push(child.name)
    else out.pending.push(child.name)
  }
  return out
}

/** `2/5 children down: api-3, api-5`, plus the degraded and pending ones. */
function failingSummary(b: Buckets): string {
  const total = b.active.length
  const parts: string[] = []
  if (b.down.length > 0) parts.push(`${b.down.length}/${total} children down: ${list(b.down)}`)
  if (b.degraded.length > 0) {
    parts.push(`${b.degraded.length}/${total} degraded: ${list(b.degraded)}`)
  }
  if (b.pending.length > 0) parts.push(`${b.pending.length}/${total} pending: ${list(b.pending)}`)
  return parts.join('; ')
}

const ALL_UP = 'All children up and running'

/** The behaviour before #144 (Uptime Kuma's group check): the worst child decides. */
function worst(b: Buckets): Omit<GroupVerdict, 'ping'> {
  if (b.down.length > 0) {
    let msg = `Child monitors down: ${list(b.down)}`
    if (b.pending.length > 0) msg += `; pending: ${list(b.pending)}`
    return { status: 'down', msg }
  }
  if (b.pending.length > 0) {
    return { status: 'pending', msg: `Pending child monitors: ${list(b.pending)}` }
  }
  if (b.degraded.length > 0) {
    return { status: 'degraded', msg: `Degraded child monitors: ${list(b.degraded)}` }
  }
  return { status: 'up', msg: ALL_UP }
}

function quorum(b: Buckets, settings: GroupAggregationSettings): Omit<GroupVerdict, 'ping'> {
  const total = b.active.length
  const required = requiredUp(total, settings.quorum, settings.quorumUnit)
  // Degraded children still serve: they count towards the quorum.
  const serving = b.up.length + b.degraded.length
  if (serving === total) {
    return b.degraded.length === 0
      ? { status: 'up', msg: ALL_UP }
      : { status: 'degraded', msg: failingSummary(b) }
  }
  const msg = `${serving}/${total} children up (quorum ${required}); ${failingSummary(b)}`
  if (serving >= required) return { status: 'degraded', msg }
  // Short of the quorum, but the pending (retrying) children could still make it.
  if (serving + b.pending.length >= required) return { status: 'pending', msg }
  return { status: 'down', msg }
}

function weighted(b: Buckets): Omit<GroupVerdict, 'ping'> {
  const score = weightedScore(b.active)
  if (score === null) {
    return { status: 'pending', msg: `Pending child monitors: ${list(b.pending)}` }
  }
  const summary = failingSummary(b)
  const msg = `Score ${Math.round(score * 100)}%${summary ? `; ${summary}` : ''}`
  const status: GroupStatus = score >= 1 ? 'up' : score <= 0 ? 'down' : 'degraded'
  return { status, msg: status === 'up' && !summary ? ALL_UP : msg, score }
}

/**
 * The group's verdict from its children. An empty group is PENDING and a group whose children are
 * all paused is UP, as before #144.
 */
export function aggregateGroup(
  children: readonly GroupChild[],
  settings: GroupAggregationSettings = {},
): GroupVerdict {
  if (children.length === 0) return { status: 'pending', msg: 'Group empty', ping: null }
  const b = bucket(children)
  const ping = groupLatency(children, settings.latency)
  const mode = settings.mode ?? DEFAULT_GROUP_AGGREGATION
  if (b.active.length === 0 || mode === 'worst') return { ...worst(b), ping }
  return { ...(mode === 'quorum' ? quorum(b, settings) : weighted(b)), ping }
}
