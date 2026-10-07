/**
 * The variables notification message templates can use (#150), as a tree of names. Client-safe:
 * the channel form lists them next to the preview, and the server checks templates against them
 * when a channel is saved (`validateTemplate`), so a typo such as `{{ monitor.nmae }}` is an error
 * instead of a silently empty value.
 *
 * Every leaf is a string at render time (`''` when unknown). `TemplateContext` in
 * `src/server/notifications/message.ts` is type-checked against this tree, and
 * `docs/Notifications.md` documents it: keep the three in step.
 *
 * `monitorJSON` and `heartbeatJSON` are the names Uptime Kuma 2.x gives the same objects
 * (`server/notification-providers/notification-provider.js`, MIT, Louis Lam), so templates written
 * for Kuma keep working after an import. See THIRD_PARTY_NOTICES.md.
 */

/** A variable tree: `true` marks a value, an object a group of variables. */
export type TemplateVariableTree = { readonly [name: string]: true | TemplateVariableTree }

const MONITOR = {
  id: true,
  name: true,
  type: true,
  url: true,
  hostname: true,
  port: true,
  description: true,
  dashboardUrl: true,
} as const

const HEARTBEAT = {
  status: true,
  msg: true,
  ping: true,
  time: true,
  duration: true,
  retries: true,
  downCount: true,
  localDateTime: true,
  timezone: true,
} as const

export const TEMPLATE_VARIABLES = {
  msg: true,
  status: true,
  event: true,
  downtime: true,
  downtimeSeconds: true,
  name: true,
  hostnameOrURL: true,
  monitor: MONITOR,
  heartbeat: HEARTBEAT,
  organization: { name: true, slug: true, logoUrl: true },
  monitorJSON: MONITOR,
  heartbeatJSON: HEARTBEAT,
} as const satisfies TemplateVariableTree

/** Dotted names of every variable (`msg`, `monitor.name`, …) in declaration order. */
export function templateVariableNames(
  tree: TemplateVariableTree = TEMPLATE_VARIABLES,
  prefix = '',
): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    value === true ? [`${prefix}${name}`] : templateVariableNames(value, `${prefix}${name}.`),
  )
}

/** Properties Liquid adds to every value (`{{ msg.size }}`, `{{ name.first }}`). */
const BUILTIN_PROPERTIES = new Set(['size', 'first', 'last'])

/** One reference found in a template: `['monitor', 'name']`; numbers and nested arrays are dynamic. */
export type TemplateVariableSegments = ReadonlyArray<string | number | unknown>

/**
 * The first unknown name in `segments` as a dotted path (`monitor.nmae`), or `null` when the
 * reference is valid. Dynamic segments (`heartbeat[key]`) end the check: they cannot be resolved
 * without rendering.
 */
export function unknownTemplateVariable(
  segments: TemplateVariableSegments,
  tree: TemplateVariableTree = TEMPLATE_VARIABLES,
): string | null {
  let node: true | TemplateVariableTree = tree
  const path: string[] = []
  for (const segment of segments) {
    if (typeof segment !== 'string') return null
    path.push(segment)
    if (node === true) return BUILTIN_PROPERTIES.has(segment) ? null : path.join('.')
    if (Object.prototype.hasOwnProperty.call(node, segment)) {
      node = node[segment]
      continue
    }
    return path.length > 1 && BUILTIN_PROPERTIES.has(segment) ? null : path.join('.')
  }
  return null
}
