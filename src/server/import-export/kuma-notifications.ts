/**
 * Uptime Kuma notification config → Marmot provider config.
 *
 * Uptime Kuma keeps every provider's settings as flat, provider-prefixed keys in one JSON blob
 * (`notification.config`, e.g. `slackwebhookURL`, `telegramBotToken`). Marmot's providers
 * (`src/server/notification-providers/*`) use a zod schema with short keys per provider. This
 * table maps the Kuma `type` names to Marmot provider slugs and the config keys one by one; the
 * key names on the Kuma side come from `server/notification-providers/*.js` and the
 * `src/components/notifications/*.vue` forms of Uptime Kuma 2.5.5 (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 *
 * Providers Marmot does not ship (yet) are absent here and are reported as skipped by the importer.
 */
import { asBool, asInt, asString } from './types'

type FieldKind = 'string' | 'number' | 'boolean'

/** `marmotKey: kumaKey` or `marmotKey: [kumaKey, kind]` (kind defaults to `string`). */
type FieldMap = Record<string, string | [string, FieldKind]>

interface ProviderMapping {
  /** Marmot provider slug. */
  type: string
  fields: FieldMap
  /** Last-mile adjustments for values whose semantics differ. */
  finish?: (config: Record<string, unknown>, raw: Record<string, unknown>) => void
}

/** Kuma `pagerdutyAutoResolve` / `splunkAutoResolve` use `"0"` for "do nothing". */
const zeroToNone = (key: string) => (config: Record<string, unknown>) => {
  if (config[key] === '0' || config[key] === 0 || config[key] === '' || config[key] === undefined) {
    config[key] = 'none'
  }
}

export const KUMA_NOTIFICATION_MAPPINGS: Record<string, ProviderMapping> = {
  discord: {
    type: 'discord',
    fields: {
      webhookUrl: 'discordWebhookUrl',
      username: 'discordUsername',
      prefixMessage: 'discordPrefixMessage',
      messageFormat: 'discordMessageFormat',
      messageTemplate: 'discordMessageTemplate',
      channelType: 'discordChannelType',
      threadId: 'threadId',
      postName: 'postName',
      suppressNotifications: ['discordSuppressNotifications', 'boolean'],
      disableUrl: ['disableUrl', 'boolean'],
    },
    finish: (config, raw) => {
      // Kuma: `discordMessageFormat || (discordUseMessageTemplate ? "custom" : "normal")`.
      if (!config.messageFormat) {
        config.messageFormat = asBool(raw.discordUseMessageTemplate) ? 'custom' : 'normal'
      }
    },
  },
  slack: {
    type: 'slack',
    fields: {
      webhookUrl: 'slackwebhookURL',
      channel: 'slackchannel',
      username: 'slackusername',
      iconEmoji: 'slackiconemo',
      richMessage: ['slackrichmessage', 'boolean'],
      channelNotify: ['slackchannelnotify', 'boolean'],
      useTemplate: ['slackUseTemplate', 'boolean'],
      template: 'slackTemplate',
    },
  },
  telegram: {
    type: 'telegram',
    fields: {
      botToken: 'telegramBotToken',
      chatId: 'telegramChatID',
      messageThreadId: 'telegramMessageThreadID',
      serverUrl: 'telegramServerUrl',
      sendSilently: ['telegramSendSilently', 'boolean'],
      protectContent: ['telegramProtectContent', 'boolean'],
      useTemplate: ['telegramUseTemplate', 'boolean'],
      template: 'telegramTemplate',
      templateParseMode: 'telegramTemplateParseMode',
    },
  },
  teams: { type: 'teams', fields: { webhookUrl: 'webhookUrl' } },
  ntfy: {
    type: 'ntfy',
    fields: {
      serverUrl: 'ntfyserverurl',
      topic: 'ntfytopic',
      priority: ['ntfyPriority', 'number'],
      priorityDown: ['ntfyPriorityDown', 'number'],
      authMethod: 'ntfyAuthenticationMethod',
      username: 'ntfyusername',
      password: 'ntfypassword',
      accessToken: 'ntfyaccesstoken',
      icon: 'ntfyIcon',
    },
  },
  gotify: {
    type: 'gotify',
    fields: {
      serverUrl: 'gotifyserverurl',
      appToken: 'gotifyapplicationToken',
      priority: ['gotifyPriority', 'number'],
    },
  },
  pushover: {
    type: 'pushover',
    fields: {
      userKey: 'pushoveruserkey',
      appToken: 'pushoverapptoken',
      device: 'pushoverdevice',
      title: 'pushovertitle',
      priority: 'pushoverpriority',
      sound: 'pushoversounds',
      soundUp: 'pushoversounds_up',
      ttl: ['pushoverttl', 'number'],
    },
  },
  matrix: {
    type: 'matrix',
    fields: {
      homeserverUrl: 'homeserverUrl',
      internalRoomId: 'internalRoomId',
      accessToken: 'accessToken',
      useTemplate: ['matrixUseTemplate', 'boolean'],
      template: 'matrixTemplate',
    },
  },
  webhook: {
    type: 'webhook',
    fields: {
      url: 'webhookURL',
      method: 'httpMethod',
      contentType: 'webhookContentType',
      customBody: 'webhookCustomBody',
      additionalHeaders: 'webhookAdditionalHeaders',
    },
  },
  smtp: {
    type: 'smtp',
    fields: {
      host: 'smtpHost',
      port: ['smtpPort', 'number'],
      secure: ['smtpSecure', 'boolean'],
      ignoreTlsErrors: ['smtpIgnoreTLSError', 'boolean'],
      user: 'smtpUsername',
      pass: 'smtpPassword',
      from: 'smtpFrom',
      to: 'smtpTo',
      cc: 'smtpCC',
      bcc: 'smtpBCC',
      subject: 'customSubject',
      body: 'customBody',
      htmlBody: ['htmlBody', 'boolean'],
    },
  },
  mattermost: {
    type: 'mattermost',
    fields: {
      webhookUrl: 'mattermostWebhookUrl',
      username: 'mattermostusername',
      channel: 'mattermostchannel',
      iconUrl: 'mattermosticonurl',
      iconEmoji: 'mattermosticonemo',
    },
  },
  'rocket.chat': {
    type: 'rocket-chat',
    fields: {
      webhookUrl: 'rocketwebhookURL',
      channel: 'rocketchannel',
      username: 'rocketusername',
      iconEmoji: 'rocketiconemo',
    },
  },
  GoogleChat: {
    type: 'google-chat',
    fields: {
      webhookUrl: 'googleChatWebhookURL',
      maxRetries: ['googleChatMaxRetries', 'number'],
      useTemplate: ['googleChatUseTemplate', 'boolean'],
      template: 'googleChatTemplate',
    },
  },
  PagerDuty: {
    type: 'pagerduty',
    fields: {
      integrationKey: 'pagerdutyIntegrationKey',
      integrationUrl: 'pagerdutyIntegrationUrl',
      priority: 'pagerdutyPriority',
      autoResolve: 'pagerdutyAutoResolve',
    },
    finish: zeroToNone('autoResolve'),
  },
  Opsgenie: {
    type: 'opsgenie',
    fields: {
      region: 'opsgenieRegion',
      apiKey: 'opsgenieApiKey',
      priority: ['opsgeniePriority', 'number'],
    },
  },
  apprise: { type: 'apprise', fields: { appriseUrl: 'appriseURL', title: 'title' } },
  signal: {
    type: 'signal',
    fields: {
      apiUrl: 'signalURL',
      number: 'signalNumber',
      recipients: 'signalRecipients',
      useTemplate: ['signalUseTemplate', 'boolean'],
      template: 'signalTemplate',
    },
  },
  HomeAssistant: {
    type: 'home-assistant',
    fields: {
      url: 'homeAssistantUrl',
      longLivedAccessToken: 'longLivedAccessToken',
      notificationService: 'notificationService',
    },
  },
  pushbullet: { type: 'pushbullet', fields: { accessToken: 'pushbulletAccessToken' } },
  twilio: {
    type: 'twilio',
    fields: {
      accountSid: 'twilioAccountSID',
      apiKey: 'twilioApiKey',
      authToken: 'twilioAuthToken',
      fromNumber: 'twilioFromNumber',
      toNumber: 'twilioToNumber',
      messagingServiceSid: 'twilioMessagingServiceSID',
    },
  },
  SendGrid: {
    type: 'sendgrid',
    fields: {
      apiKey: 'sendgridApiKey',
      fromEmail: 'sendgridFromEmail',
      toEmail: 'sendgridToEmail',
      ccEmail: 'sendgridCcEmail',
      bccEmail: 'sendgridBccEmail',
      subject: 'sendgridSubject',
    },
  },
  Resend: {
    type: 'resend',
    fields: {
      apiKey: 'resendApiKey',
      fromEmail: 'resendFromEmail',
      fromName: 'resendFromName',
      toEmail: 'resendToEmail',
      subject: 'resendSubject',
    },
  },
  Bark: {
    type: 'bark',
    fields: {
      endpoint: 'barkEndpoint',
      apiVersion: 'apiVersion',
      group: 'barkGroup',
      sound: 'barkSound',
    },
  },
  PushDeer: { type: 'pushdeer', fields: { serverUrl: 'pushdeerServer', pushKey: 'pushdeerKey' } },
  ServerChan: { type: 'serverchan', fields: { sendKey: 'serverChanSendKey' } },
  Splunk: {
    type: 'splunk',
    fields: {
      restUrl: 'splunkRestURL',
      severity: 'splunkSeverity',
      autoResolve: 'splunkAutoResolve',
    },
    finish: zeroToNone('autoResolve'),
  },
  squadcast: { type: 'squadcast', fields: { webhookUrl: 'squadcastWebhookURL' } },
  PushByTechulus: {
    type: 'techulus-push',
    fields: {
      apiKey: 'pushAPIKey',
      title: 'pushTitle',
      channel: 'pushChannel',
      sound: 'pushSound',
      timeSensitive: ['pushTimeSensitive', 'boolean'],
    },
  },
  pushy: { type: 'pushy', fields: { apiKey: 'pushyAPIKey', deviceToken: 'pushyToken' } },
  OneBot: {
    type: 'onebot',
    fields: {
      httpAddr: 'httpAddr',
      accessToken: 'accessToken',
      msgType: 'msgType',
      // sic: Kuma misspells the key.
      receiverId: 'recieverId',
    },
  },
  WeCom: {
    type: 'wecom',
    fields: { botKey: 'weComBotKey', mentionedMobileList: 'weComMentionedMobileList' },
  },
  DingDing: {
    type: 'dingding',
    fields: {
      webhookUrl: 'webHookUrl',
      secretKey: 'secretKey',
      mentioning: 'mentioning',
      mobileList: 'mobileList',
      userList: 'userList',
    },
  },
  Feishu: { type: 'feishu', fields: { webhookUrl: 'feishuWebHookUrl' } },
  Bitrix24: {
    type: 'bitrix24',
    fields: { webhookUrl: 'bitrix24WebhookURL', userId: 'bitrix24UserID' },
  },
  line: {
    type: 'line-messaging',
    fields: { channelAccessToken: 'lineChannelAccessToken', userId: 'lineUserID' },
  },
  pumble: { type: 'pumble', fields: { webhookUrl: 'webhookURL' } },
  ZohoCliq: { type: 'zoho-cliq', fields: { webhookUrl: 'webhookUrl' } },
  clicksendsms: {
    type: 'clicksend',
    fields: {
      login: 'clicksendsmsLogin',
      password: 'clicksendsmsPassword',
      toNumber: 'clicksendsmsToNumber',
      senderName: 'clicksendsmsSenderName',
    },
  },
  alerta: {
    type: 'alerta',
    fields: {
      apiEndpoint: 'alertaApiEndpoint',
      apiKey: 'alertaApiKey',
      environment: 'alertaEnvironment',
      alertState: 'alertaAlertState',
      recoverState: 'alertaRecoverState',
    },
  },
  GrafanaOncall: { type: 'grafana-oncall', fields: { webhookUrl: 'GrafanaOncallURL' } },
  HeiiOnCall: {
    type: 'heii-oncall',
    fields: { apiKey: 'heiiOnCallApiKey', triggerId: 'heiiOnCallTriggerId' },
  },
  nextcloudtalk: {
    type: 'nextcloud-talk',
    fields: {
      host: 'host',
      conversationToken: 'conversationToken',
      botSecret: 'botSecret',
      sendSilentUp: ['sendSilentUp', 'boolean'],
      sendSilentDown: ['sendSilentDown', 'boolean'],
    },
  },
  // Webpush is deliberately absent: Kuma keeps the VAPID key pair in its server settings, which the
  // backup does not contain, so a subscription alone cannot be delivered to.
}

/**
 * Maps one Kuma notification config to `{ type, config }` for a Marmot provider, or `null` when the
 * Kuma provider has no Marmot counterpart. Only keys present in the Kuma config are copied; the
 * provider's zod schema fills the defaults when the channel is validated.
 */
export function mapKumaNotificationConfig(
  kumaType: string,
  raw: Record<string, unknown>,
): { type: string; config: Record<string, unknown> } | null {
  const mapping = KUMA_NOTIFICATION_MAPPINGS[kumaType]
  if (!mapping) return null

  const config: Record<string, unknown> = {}
  for (const [marmotKey, spec] of Object.entries(mapping.fields)) {
    const [kumaKey, kind] = typeof spec === 'string' ? [spec, 'string' as FieldKind] : spec
    const value = raw[kumaKey]
    if (value === undefined || value === null || value === '') continue
    switch (kind) {
      case 'boolean': {
        const b = asBool(value)
        if (b !== null) config[marmotKey] = b
        break
      }
      case 'number': {
        const n = asInt(value)
        if (n !== null) config[marmotKey] = n
        break
      }
      default: {
        const s = asString(value)
        if (s !== null) config[marmotKey] = s
      }
    }
  }
  mapping.finish?.(config, raw)
  return { type: mapping.type, config }
}

/** Kuma provider names that Marmot can import. */
export const SUPPORTED_KUMA_NOTIFICATION_TYPES = Object.keys(KUMA_NOTIFICATION_MAPPINGS)
