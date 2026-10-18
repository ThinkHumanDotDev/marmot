/**
 * Status-page subscriber messages to channels subscribed through the Slack app (#129):
 * `chat.postMessage` with the workspace's bot token instead of an incoming webhook. Failures become
 * `DeliveryError`s for the subscriber retry policy: rate limits and network errors retry, a missing
 * installation, channel or token does not.
 */
import type { Payload } from 'payload'

import { parseSlackAppTarget } from '@/lib/slack-app'
import { isDemoMode } from '@/server/demo/config'
import { deliverToDemoSink } from '@/server/demo/sink'
import { DeliveryError } from '@/server/status-pages/subscribers/deliver'

import { isPermanentSlackError, slackApi, SlackApiError } from './api'
import { isSlackAppEnabled } from './config'
import { findInstallationByTeam, installationToken } from './installations'

/** Posts `message` (Block Kit: `text`, `blocks`) to the channel of a `slack://` target. */
export async function postSlackAppSubscriberMessage(
  payload: Payload,
  target: string,
  message: Record<string, unknown>,
  meta: { event: string; deliveryId: string },
): Promise<void> {
  const parsed = parseSlackAppTarget(target)
  if (!parsed) throw new DeliveryError('Not a Slack app channel', 'refused', false)
  if (isDemoMode()) {
    deliverToDemoSink('subscriber-webhook', meta)
    return
  }
  if (!isSlackAppEnabled()) throw new DeliveryError('The Slack app is disabled', 'refused', false)
  const installation = await findInstallationByTeam(payload, parsed.teamId)
  const token = installation ? installationToken(installation) : null
  if (!token) throw new DeliveryError('The Slack app is not installed', 'refused', false)
  try {
    await slackApi('chat.postMessage', token, {
      ...message,
      channel: parsed.channelId,
      unfurl_links: false,
      unfurl_media: false,
    })
  } catch (err) {
    if (!(err instanceof SlackApiError)) throw err
    if (err.code === 'ratelimited') throw new DeliveryError(err.message, 'rate-limited', true)
    if (err.code === 'network') throw new DeliveryError(err.message, 'network', true)
    throw new DeliveryError(
      err.message,
      err.status !== null ? 'http' : 'refused',
      !isPermanentSlackError(err),
    )
  }
}
