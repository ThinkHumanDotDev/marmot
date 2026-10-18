/**
 * Delivery of "Slack (app)" channel messages (#129, `src/server/notification-providers/slack-app.ts`):
 * the organization's installation posts the alert with its bot token. Loaded lazily by the provider
 * so the provider registry does not import Payload.
 */
import { getPayload } from 'payload'

import config from '@payload-config'

import { slackApi } from './api'
import { findInstallationByOrg, installationToken } from './installations'

export async function postSlackAppAlert(
  orgId: string | number | null,
  channel: string,
  message: { text: string; blocks: unknown[] },
): Promise<void> {
  if (orgId === null || orgId === '') throw new Error('The channel has no organization')
  const payload = await getPayload({ config })
  const installation = await findInstallationByOrg(payload, orgId)
  const token = installation ? installationToken(installation) : null
  if (!token) {
    throw new Error(
      'The Slack app is not installed for this organization (Settings → Integrations)',
    )
  }
  await slackApi('chat.postMessage', token, {
    channel,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false,
  })
}
