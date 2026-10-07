/**
 * Email to an organization's owners and admins when the worker disabled one of its webhook
 * endpoints after too many failed deliveries (#157). Sent in the organization's language.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Organization, WebhookEndpoint } from '@/payload-types'
import { getOrganizationI18n, serverTranslator } from '@/server/i18n'
import { listOrgMembers } from '@/server/members'
import { serverUrl } from '@/server/status-pages/urls'

import { displayUrl } from './url'

const log = childLogger('webhooks:disabled-email')

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

export function renderEndpointDisabledEmail({
  to,
  locale,
  organizationName,
  endpointUrl,
  failures,
  lastError,
  settingsUrl,
}: {
  to: string
  locale: Parameters<typeof serverTranslator>[0]
  organizationName: string
  endpointUrl: string
  failures: number
  lastError: string | null
  settingsUrl: string
}): { to: string; subject: string; text: string; html: string } {
  const t = serverTranslator(locale)
  const values = { organization: organizationName, url: endpointUrl, count: failures }
  const intro = t('email.webhookDisabled.intro', values)
  const error = lastError ? t('email.webhookDisabled.lastError', { error: lastError }) : null
  const action = t('email.webhookDisabled.action')
  return {
    to,
    subject: t('email.webhookDisabled.subject', values),
    text: [intro, error, `${action} ${settingsUrl}`].filter(Boolean).join('\n\n'),
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      error ? `<p>${escapeHtml(error)}</p>` : '',
      `<p>${escapeHtml(action)} <a href="${escapeHtml(settingsUrl)}">${escapeHtml(settingsUrl)}</a></p>`,
    ].join(''),
  }
}

/** Emails every owner and admin of the endpoint's organization. Returns how many were sent. */
export async function notifyEndpointDisabled(
  payload: Payload,
  endpoint: WebhookEndpoint,
  { failures, lastError }: { failures: number; lastError: string | null },
): Promise<number> {
  const orgId = relId(endpoint.organization)
  if (orgId === null) return 0
  const organization = (await payload.findByID({
    collection: 'organizations',
    id: orgId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as Organization | null
  if (!organization) return 0

  const members = await listOrgMembers(payload, orgId, { overrideAccess: true })
  const recipients = members.filter((m) => m.role === 'owner' || m.role === 'admin')
  const { locale } = await getOrganizationI18n(payload, organization)
  const settingsUrl = `${serverUrl()}/${organization.slug}/settings/webhooks`
  let sent = 0
  for (const recipient of recipients) {
    try {
      await payload.sendEmail(
        renderEndpointDisabledEmail({
          to: recipient.email,
          locale,
          organizationName: organization.name,
          endpointUrl: displayUrl(endpoint.url) ?? endpoint.url,
          failures,
          lastError,
          settingsUrl,
        }),
      )
      sent += 1
    } catch (err) {
      log.error({ err, endpoint: endpoint.id }, 'cannot send the webhook disabled email')
    }
  }
  return sent
}
