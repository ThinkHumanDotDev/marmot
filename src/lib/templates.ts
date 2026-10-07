/**
 * Incident and maintenance templates (issue #153): pre-approved wording that the incident dialog,
 * the incident update composer, the maintenance form and the maintenance update composer pre-fill
 * from. Shared by the `templates` collection,
 * the import/export mappers and the client, so it imports nothing server-only.
 *
 * A template's title and body may contain `{{ placeholders }}`. When a template is applied, the
 * variables of its kind (`TEMPLATE_VARIABLES`) that are known at that moment are filled in; every
 * other placeholder (`{{ eta }}`, a variable without a value) stays in the text, is highlighted, and
 * blocks publishing until the author replaces it (`findPlaceholders`). Rendering goes through the
 * same safe renderer as notification templates (`src/lib/placeholders.ts`).
 */
import {
  isComponentImpact as isImpact,
  isIncidentStatus as isStatus,
  type ComponentImpact,
  type IncidentStatus,
} from '@/lib/incident-timeline'
import { findPlaceholders, renderPlaceholders } from '@/lib/placeholders'

export { findPlaceholders }

export const TEMPLATE_KINDS = [
  'incident',
  'incident-update',
  'maintenance',
  'maintenance-update',
] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

/** Maintenance kinds carry no incident status, impact or components. */
export const isMaintenanceKind = (kind: TemplateKind): boolean =>
  kind === 'maintenance' || kind === 'maintenance-update'

/** Update kinds pre-fill a message only, so they have no title. */
export const isUpdateKind = (kind: TemplateKind): boolean =>
  kind === 'incident-update' || kind === 'maintenance-update'

export const isTemplateKind = (value: unknown): value is TemplateKind =>
  typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value)

/**
 * Variables filled in automatically when a template of each kind is applied. Keep this list in
 * `docs/Status-Pages.md` → Templates.
 *
 * - `organization`: the organization's name
 * - `page`: the status page's title
 * - `components` (alias `component`): names of the affected components, as a list
 * - `incident`: the incident's title (updates only)
 * - `date`: today's date
 * - `start`, `end`, `duration`: the maintenance window, when the form already has it (for an
 *   update: the occurrence's window)
 * - `maintenance`: the maintenance's title (maintenance updates only)
 */
export const TEMPLATE_VARIABLES = {
  incident: ['organization', 'page', 'components', 'component', 'date'],
  'incident-update': ['organization', 'page', 'components', 'component', 'incident', 'date'],
  maintenance: ['organization', 'start', 'end', 'duration', 'date'],
  'maintenance-update': ['organization', 'maintenance', 'start', 'end', 'date'],
} as const satisfies Record<TemplateKind, readonly string[]>

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[TemplateKind][number]
export type TemplateValues = Partial<Record<TemplateVariable, string | null>>

/** Upper bound of a maintenance template's default duration: the maintenance form's own. */
export { MAX_DURATION_MINUTES as TEMPLATE_MAX_DURATION_MINUTES } from '@/lib/validation/maintenance'

export interface TemplateComponentImpact {
  /** Component id: a group row id of `statusPage`. */
  component: string
  impact: ComponentImpact
}

/** A template as the editor and the composers use it (`toTemplateRow`). */
export interface TemplateRow {
  id: string
  name: string
  kind: TemplateKind
  title: string
  body: string
  /** Incident status the incident / update starts with. */
  status: IncidentStatus | null
  /** Overall impact for incidents that affect no component. */
  impact: ComponentImpact | null
  /** Status page the default components belong to; `null` = every page of the organization. */
  statusPage: string | null
  components: TemplateComponentImpact[]
  /** Maintenance: default window length in minutes. */
  duration: number | null
}

const relationKey = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return null
}

/** Reads a `templates` document (any depth) into the client shape. */
export function toTemplateRow(input: object): TemplateRow {
  const doc = input as Record<string, unknown>
  const components = Array.isArray(doc.components) ? doc.components : []
  return {
    id: String(doc.id),
    name: String(doc.name ?? ''),
    kind: isTemplateKind(doc.kind) ? doc.kind : 'incident',
    title: typeof doc.title === 'string' ? doc.title : '',
    body: typeof doc.body === 'string' ? doc.body : '',
    status: isStatus(doc.status) ? doc.status : null,
    impact: isImpact(doc.impact) ? doc.impact : null,
    statusPage: relationKey(doc.statusPage),
    components: components.flatMap((row) => {
      const entry = row as { component?: unknown; impact?: unknown } | null
      return entry && typeof entry.component === 'string' && isImpact(entry.impact)
        ? [{ component: entry.component, impact: entry.impact }]
        : []
    }),
    duration: typeof doc.duration === 'number' && doc.duration > 0 ? doc.duration : null,
  }
}

/** Templates of `kind` offered on a page: the page's own and the organization-wide ones. */
export function templatesFor(
  templates: readonly TemplateRow[],
  kind: TemplateKind,
  pageId?: string | number | null,
): TemplateRow[] {
  return templates.filter(
    (template) =>
      template.kind === kind &&
      (template.statusPage === null ||
        (pageId !== undefined && pageId !== null && template.statusPage === String(pageId))),
  )
}

/**
 * Fills the variables of `kind` that have a value; everything else (unknown placeholders, empty
 * variables) stays in the text for the author.
 */
export function renderTemplateText(
  text: string,
  kind: TemplateKind,
  values: TemplateValues,
): string {
  const allowed = TEMPLATE_VARIABLES[kind] as readonly string[]
  return renderPlaceholders(text, (path) => {
    if (!allowed.includes(path)) return undefined
    const value = values[path as TemplateVariable]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  })
}

/** Default component impacts of a template that exist among `componentIds` (the page's). */
export function templateImpacts(
  template: Pick<TemplateRow, 'components'>,
  componentIds: Iterable<string>,
): Record<string, ComponentImpact> {
  const known = new Set(componentIds)
  const impacts: Record<string, ComponentImpact> = {}
  for (const row of template.components) {
    if (known.has(row.component)) impacts[row.component] = row.impact
  }
  return impacts
}

/**
 * Template placeholders (`{{ eta }}`) left in text about to be published: the values for the
 * `templatePlaceholdersUnfilled` error, or `null` when there are none. Markdown code is ignored.
 */
export function unfilledPlaceholders(...texts: unknown[]): { names: string } | null {
  const names = findPlaceholders(
    ...texts.filter((text): text is string => typeof text === 'string'),
  )
  return names.length > 0 ? { names: names.map((name) => `{{ ${name} }}`).join(', ') } : null
}

/** Replaces every `{{ name }}` placeholder with `value` (the "fill in" field of the composers). */
export function fillPlaceholder(text: string, name: string, value: string): string {
  return renderPlaceholders(text, (path) => (path === name ? value : undefined))
}
