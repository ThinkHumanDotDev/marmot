/**
 * `beforeChange` of `integrations` (#152): every writer (the management API, the Payload admin, the
 * REST API) gets the same checks. Rules may only point at status pages, components and push monitors
 * of the integration's own organization, regexes must compile, and a rule that changes a component
 * or publishes an incident needs a status page.
 */
import { ValidationError, type CollectionBeforeChangeHook, type PayloadRequest } from 'payload'

import { MAX_RULES, ruleRegex } from '@/lib/inbound-alerts'
import type { Integration, StatusPage } from '@/payload-types'
import { pageComponentIds } from '@/collections/Incidents'
import type { ErrorKey } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'

import { generateIntegrationToken } from './token'

type Id = string | number

const relId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const invalid = (req: PayloadRequest, key: ErrorKey, path: string): never => {
  throw new ValidationError({
    collection: 'integrations',
    errors: [{ message: userErrorText(req, key), path }],
  })
}

export const validateIntegration: CollectionBeforeChangeHook<Integration> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  if (operation === 'create' && !data.tokenHash) {
    // Created without the management API (Payload admin): the token is unknown until rotated.
    const generated = generateIntegrationToken()
    data.tokenHash = generated.hash
    data.tokenPrefix = generated.prefix
  }
  if (operation === 'update' && originalDoc) data.organization = originalDoc.organization
  if (req.context.integrationBookkeeping) return data

  const orgId = relId(data.organization ?? originalDoc?.organization)
  if (orgId === null) return data
  const rules = Array.isArray(data.rules) ? data.rules : (originalDoc?.rules ?? [])
  if (rules.length > MAX_RULES) invalid(req, 'integrationTooManyRules', 'rules')

  const pages = new Map<string, StatusPage | null>()
  const loadPage = async (id: Id): Promise<StatusPage | null> => {
    const key = String(id)
    if (!pages.has(key)) {
      const page = await req.payload
        .findByID({ collection: 'status-pages', id, depth: 0, overrideAccess: true, req })
        .catch(() => null)
      pages.set(key, page && String(relId(page.organization)) === String(orgId) ? page : null)
    }
    return pages.get(key) ?? null
  }

  for (const [index, rule] of rules.entries()) {
    const path = `rules.${index}`
    if (rule.matchOperator === 'regex' && rule.matchValue?.trim()) {
      if (!ruleRegex(rule.matchValue.trim()))
        invalid(req, 'integrationRuleRegexInvalid', `${path}.matchValue`)
    }
    const pageId = relId(rule.statusPage)
    const needsPage = rule.updateComponent === true || rule.incident === 'publish'
    if (pageId === null) {
      if (needsPage) invalid(req, 'integrationRuleStatusPageInvalid', `${path}.statusPage`)
    } else {
      const page = await loadPage(pageId)
      if (!page) invalid(req, 'integrationRuleStatusPageInvalid', `${path}.statusPage`)
      if (rule.updateComponent === true || rule.component) {
        if (!rule.component || !pageComponentIds(page as StatusPage).has(String(rule.component))) {
          invalid(req, 'integrationRuleComponentInvalid', `${path}.component`)
        }
      }
    }
    const monitorId = relId(rule.monitor)
    if (monitorId !== null) {
      const monitor = await req.payload
        .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true, req })
        .catch(() => null)
      if (
        !monitor ||
        monitor.type !== 'push' ||
        String(relId(monitor.organization)) !== String(orgId)
      ) {
        invalid(req, 'integrationRuleMonitorInvalid', `${path}.monitor`)
      }
    }
  }
  return data
}
