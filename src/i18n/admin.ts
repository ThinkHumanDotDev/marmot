import type { NestedKeysStripped, TFunction } from '@payloadcms/translations'
import { en } from '@payloadcms/translations/languages/en'
import type { Config } from 'payload'

/**
 * Payload admin panel translations. Payload ships its own UI strings
 * (`@payloadcms/translations`); Marmot's custom labels, descriptions and messages live under the
 * `marmot:` namespace and are referenced as `label: adminT('marmot:language')` (nested keys are
 * colon-separated: `adminT('marmot:monitors:intervalDescription')`), `req.t('marmot:…')`
 * in hooks and `useTranslation()` from `@payloadcms/ui` in admin components. The admin language is
 * separate from the Marmot UI locale (`src/i18n/locales.ts`); a language is only offered here once
 * both Payload and Marmot have a catalogue for it.
 */
export const adminTranslations = {
  en: {
    marmot: {
      language: 'Language',
      userLanguageDescription:
        'Language of the Marmot interface, emails and notifications for this user.',
      organizationLanguageDescription:
        'Default language of notifications and emails sent on behalf of this organization.',
      statusPageLanguageDescription:
        'Language visitors see the page in. "Follow the visitor" uses the browser language.',
      followVisitor: 'Follow the visitor',
      // Select options and field group labels that are words, not product names.
      labels: {
        tcpPort: 'TCP Port',
        push: 'Push',
        group: 'Group',
        manual: 'Manual',
        dockerContainer: 'Docker Container',
        httpKeyword: 'HTTP(s) - Keyword',
        httpJsonQuery: 'HTTP(s) - Json Query',
        grpcKeyword: 'gRPC(s) - Keyword',
        websocketUpgrade: 'WebSocket Upgrade',
        kafkaProducerType: 'Kafka Producer',
        tailscalePing: 'Tailscale Ping',
        realBrowser: 'HTTP(s) - Browser Engine (Chrome/Chromium)',
        steam: 'Steam Game Server',
        httpOptions: 'HTTP options',
        keyword: 'Keyword',
        jsonQuery: 'JSON query',
        authentication: 'Authentication',
        none: 'None',
        bearerToken: 'Bearer token',
        oauth2ClientCredentials: 'OAuth2 client credentials',
        up: 'Up',
        down: 'Down',
        pending: 'Pending',
        database: 'Database',
        kafkaProducer: 'Kafka producer',
        starttlsOpportunistic: 'STARTTLS if offered',
        starttlsRequired: 'Require STARTTLS',
        smtps: 'SMTPS (implicit TLS)',
        starttlsIgnore: 'Ignore STARTTLS',
        password: 'Password',
        privateKey: 'Private key',
        formBody: 'Form (x-www-form-urlencoded)',
        instanceSettings: 'Instance settings',
        dashboard: 'Dashboard',
        statusPage: 'Status page',
        thirdPartyApiKeys: 'Third-party API keys',
      },
      maintenanceStrategies: {
        manual: 'Manual (active until you pause it)',
        single: 'Single maintenance window',
        'recurring-interval': 'Recurring – every N days',
        'recurring-weekday': 'Recurring – days of the week',
        'recurring-day-of-month': 'Recurring – days of the month',
        cron: 'Cron expression',
      },
      maintenanceStatuses: {
        inactive: 'Paused',
        scheduled: 'Scheduled',
        'under-maintenance': 'Under maintenance',
        ended: 'Ended',
        unknown: 'Unknown',
      },
      weekdays: {
        '0': 'Sun',
        '1': 'Mon',
        '2': 'Tue',
        '3': 'Wed',
        '4': 'Thu',
        '5': 'Fri',
        '6': 'Sat',
      },
      lastDays: {
        lastDay1: 'Last day of the month',
        lastDay2: '2nd last day of the month',
        lastDay3: '3rd last day of the month',
        lastDay4: '4th last day of the month',
      },
      // Admin sidebar groups (`admin.group: adminGroup('monitoring')`).
      groups: {
        access: 'Access',
        content: 'Content',
        monitoring: 'Monitoring',
        statistics: 'Statistics',
        statusPages: 'Status pages',
        system: 'System',
      },
      // Field and collection descriptions, by collection: `marmot:<collection>:<field>Description`.
      apiKeys: {
        keyHashDescription: 'SHA-256 of the plaintext key.',
        prefixDescription: 'Public identifier shown in the UI (mk_<prefix>).',
        activeDescription: 'Disabled keys are rejected.',
        expiresAtDescription: 'Leave empty for a key that never expires.',
      },
      auditLogs: {
        description:
          'Security-relevant events. Rows are written by the server and cannot be edited.',
        targetDescription: 'Affected record, e.g. user:42.',
      },
      authAccounts: {
        description: 'Single sign-on identities linked to users. Managed by the login flows.',
      },
      dockerHosts: {
        socketPathDescription: 'Unix socket of the Docker daemon, as seen by the worker.',
        urlDescription: 'tcp:// and http:// connect in plain text; https:// uses TLS.',
        connectionTypeSocket: 'Socket',
        connectionTypeTcp: 'TCP / HTTP',
      },
      heartbeats: {
        organizationDescription: 'Denormalised from the monitor for org-scoped queries.',
        pingDescription: 'Response time in milliseconds (null when not measured).',
        durationDescription: 'Seconds since the previous heartbeat of this monitor.',
        importantDescription: 'True when the status changed compared to the previous heartbeat.',
      },
      incidents: {
        organizationDescription: 'Derived from the status page.',
        contentDescription: 'Markdown: paragraphs, **bold**, _italics_, `code` and links.',
        pinnedDescription: 'Pinned incidents are shown above the monitor groups.',
        activeDescription:
          'Derived from the timeline. Unchecking posts a "resolved" update; checking reopens.',
        statusDescription: 'Status of the latest update.',
        impactDescription:
          'Worst current impact of the affected components; set it directly when no component is affected.',
        updatesDescription:
          'Timeline, oldest first. Posted updates keep their status and impact; editing the text marks them as edited.',
        componentsDescription:
          'Impact on status page components. Components left out keep their last impact; "resolved" resets them.',
        affectedComponentsDescription:
          'Current impact per component, derived from the updates. Editing it posts an update.',
        componentDescription: 'Id of a component (group row) of the status page.',
      },
      invitations: {
        tokenDescription: 'Generated on create.',
      },
      maintenance: {
        descriptionDescription: 'Shown on status pages.',
        activeDescription: 'Paused maintenances never run.',
        statusDescription:
          'Maintained by the server from the occurrences: under maintenance while one is in progress.',
        dateRangeDescription:
          'Single window: when it runs. Recurring/cron: optional effective range. Wall-clock in the time zone above (YYYY-MM-DDTHH:mm).',
        timeRangeDescription: 'Daily window (HH:mm); an end before the start runs past midnight.',
        intervalDayDescription: 'Run every N days, counted from the start date.',
        daysOfMonthDescription:
          'Only "Last day of the month" has a cron equivalent; 2nd–4th last are ignored.',
        cronDescription: 'Five-field cron expression, evaluated in the time zone.',
        durationDescription: 'Minutes each occurrence lasts.',
        monitorsDescription:
          'Affected monitors: checks are skipped and MAINTENANCE heartbeats written.',
        statusPagesDescription: 'Status pages that announce this maintenance.',
        timezoneDescription:
          "IANA time zone the schedule is written in, or {{sameAsServer}} for the organization's zone.",
        autoStartDescription:
          'Start each window at its planned time. Off: it stays scheduled until someone starts it.',
        autoCompleteDescription:
          'Complete each window at its planned end. Off: it stays in progress (and keeps suppressing alerts) until someone completes it.',
        remindersDescription:
          'Minutes before the start at which status page subscribers are reminded.',
      },
      maintenanceOccurrences: {
        description:
          'Concrete windows of maintenances with their state and public update timeline. Managed by the server.',
        startDescription: 'Planned start of this window.',
        endDescription: 'Planned end; empty for manual maintenances.',
        remindersSentDescription: 'Reminder offsets (minutes) already sent or skipped.',
        updatesDescription: 'Public timeline: one entry per state change or posted update.',
      },
      monitors: {
        statusDescription: 'Maintained by the worker. Mirrors the latest heartbeat.',
        lastPushAtDescription: 'Push monitors: time of the last call to the push endpoint.',
        activeDescription: 'Paused monitors are not checked.',
        parentDescription: 'Group this monitor belongs to.',
        publicNameDescription: 'Name shown on status pages instead of the monitor name.',
        tagsDescription: 'Tags (optionally with a value, e.g. env: prod) shown as chips.',
        notificationsDescription: 'Channels alerted when this monitor changes status.',
        weightDescription: 'Sort order on status pages.',
        proxyDescription: 'Send the request through this proxy (inactive proxies are skipped).',
        dockerContainerDescription: 'Container name or id.',
        portDescription: 'DNS monitors: port of the resolver (default 53).',
        intervalDescription: 'Seconds between checks (UI minimum 20).',
        retryIntervalDescription: 'Seconds between checks while pending (retrying).',
        maxRetriesDescription: 'Retries before the monitor is marked DOWN.',
        resendIntervalDescription: 'Re-notify every N consecutive DOWN beats (0 = never).',
        timeoutDescription: 'Request timeout in seconds (0 = 80% of the interval).',
        upsideDownDescription: 'Flip status: a failed check counts as UP and vice versa.',
        headersDescription: 'JSON object of extra request headers.',
        acceptedStatusCodesDescription: 'Status codes or ranges counted as UP, e.g. 200-299, 304.',
        expiryNotificationDescription:
          'Notify before the TLS certificate expires (tlsExpiryNotifyDays).',
        domainExpiryNotificationDescription:
          'Notify before the domain registration expires (domainExpiryNotifyDays).',
        certInfoDescription:
          'Maintained by the worker: TLS certificate seen by the last HTTPS check.',
        domainExpiryDescription: 'Maintained by the worker: cached RDAP domain expiry lookup.',
        invertKeywordDescription: 'UP when the keyword is absent.',
        jsonPathDescription: 'JSONata expression, e.g. `$.status` or `data[0].ok`.',
        dnsResolveServerDescription: 'Comma-separated resolver IPs or hostnames.',
        pushTokenDescription:
          'Generated automatically. Call /api/push/<token> to report a heartbeat.',
        databaseConnectionStringDescription:
          'Driver connection string, e.g. postgres://user:pass@host:5432/db, mysql://…, mongodb://…, redis://….',
        databaseQueryDescription:
          'SQL statement to run (default SELECT 1). MongoDB: JSON command document (default {"ping": 1}).',
        mqttSuccessMessageDescription: 'Keyword mode: the received message must contain this text.',
        kafkaProducerBrokersDescription: 'Broker addresses, e.g. kafka1:9092.',
        kafkaProducerSaslOptionsDescription:
          'JSON object with mechanism (plain, scram-sha-256, scram-sha-512) and username/password.',
        grpcProtobufDescription: 'Proto definition of the service.',
        grpcBodyDescription: 'JSON request body.',
        grpcMetadataDescription: 'JSON object of request metadata.',
        sftpPathDescription: 'Optional remote path that must exist.',
        rabbitmqNodesDescription: 'Management API base URLs, e.g. https://node1:15672.',
        wsSubprotocolDescription: 'Comma-separated Sec-WebSocket-Protocol values.',
        wsIgnoreSecWebsocketAcceptHeaderDescription:
          'Accept non-compliant servers that omit Sec-WebSocket-Accept.',
        gameDescription: 'GameDig game id, e.g. minecraft.',
        gamedigGivenPortOnlyDescription: 'Do not probe the other ports a game commonly uses.',
        remoteBrowserDescription: 'Playwright-compatible remote browser websocket URL.',
      },
      notificationSentHistory: {
        description:
          'Expiry warnings already sent per monitor and threshold. Maintained by the worker.',
        organizationDescription: 'Denormalised from the monitor for org-scoped queries.',
        daysDescription: 'Threshold (days before expiry) the warning was sent for.',
      },
      notifications: {
        typeDescription: 'Provider slug, e.g. discord, slack, smtp (see docs/Notifications.md).',
        configDescription: 'Provider-specific settings; validated against the provider schema.',
        isDefaultDescription: 'Attach this channel to every new monitor of the organization.',
        applyExistingDescription: 'On save, also attach this channel to all existing monitors.',
        activeDescription: 'Inactive channels are never sent to.',
        lastSentAtDescription: 'Maintained by the worker.',
        lastErrorDescription: 'Last delivery error; cleared on the next success.',
      },
      organizations: {
        slugDescription: 'Lowercase letters, numbers and hyphens. Used in URLs.',
        planDescription: 'Self-hosted installs are unlimited regardless of plan.',
        subscriptionStatusDescription: 'Maintained by Stripe webhooks when billing is enabled.',
        inviteLinkTokenDescription:
          'Secret of the shareable invite link. Regenerate from the members page.',
        inviteLinkRoleDescription: 'Role granted to people who join through the invite link.',
        permissionOverridesDescription:
          'Per-organization minimum roles, e.g. { "monitor:create": "admin" }. Unset permissions use the defaults in src/access/permissions.ts.',
        enforceSsoDescription:
          "Require single sign-on: password logins are refused for users on this organization's verified domains. Owners keep a break-glass password login (audited).",
        timezoneDescription: 'IANA time zone, e.g. Europe/London.',
        weekStartMonday: 'Monday',
        weekStartSunday: 'Sunday',
      },
      proxies: {
        authDescription: 'The proxy requires a username and password.',
        passwordDescription: 'Only visible to users who may edit proxies.',
        activeDescription: 'Inactive proxies are ignored: monitors connect directly.',
        defaultDescription: 'Preselected for new HTTP monitors. One per organization.',
      },
      ssoConnections: {
        nameDescription: 'Login button label.',
        slugDescription: 'Used in the login URLs; lowercase letters, numbers and hyphens.',
        enabledDescription: 'Disabled connections refuse logins.',
        issuerUrlDescription: 'Issuer identifier (the `iss` claim); discovery is read from it.',
        clientSecretDescription: 'Sealed at rest. Leave empty to keep the current secret.',
        idpEntryPointDescription: 'IdP single sign-on URL (HTTP-Redirect binding).',
        idpEntityIdDescription:
          'IdP entity id (issuer). Responses from any other issuer are refused.',
        idpCertDescription: 'IdP signing certificate (PEM or bare base64).',
        allowIdpInitiatedDescription:
          'Accept logins started at the identity provider (unsolicited responses).',
        autoProvisionDescription:
          'Create a Marmot account on first login and add it to the organization.',
        defaultRoleDescription: 'Role given to users who join through SSO.',
      },
      ssoDomains: {
        verificationTokenDescription: 'Value of the DNS TXT record that proves ownership.',
      },
      stats: {
        minute: {
          label: 'Stats (minutely)',
          description: 'Per-monitor heartbeat aggregates, one row per minute.',
          timestampDescription: 'Unix seconds, truncated to the start of the minute (UTC).',
        },
        hour: {
          label: 'Stats (hourly)',
          description: 'Per-monitor heartbeat aggregates, one row per hour.',
          timestampDescription: 'Unix seconds, truncated to the start of the hour (UTC).',
        },
        day: {
          label: 'Stats (daily)',
          description: 'Per-monitor heartbeat aggregates, one row per day.',
          timestampDescription: 'Unix seconds, truncated to the start of the day (UTC).',
        },
        pingDescription: 'Average ping (ms) of UP beats.',
        extrasDescription: 'Additional counters, e.g. { maintenance, pingCount }.',
      },
      statusPages: {
        slugDescription: 'Public URL: /status/<slug>. Lowercase letters, numbers, hyphens.',
        publishedDescription: 'Unpublished pages return 404 to visitors.',
        accessDescription: 'password: visitors must enter the page password first.',
        passwordDescription:
          'Set or change the page password. Changing it signs every visitor out.',
        autoRefreshIntervalDescription:
          'Seconds between client refreshes; 0 disables auto refresh.',
        customCSSDescription: 'Injected into the public page as a <style> tag.',
        domainsDescription:
          'Custom hostnames that serve this page at their root (CNAME them to this server).',
        groupsDescription: 'Monitors are shown in these groups, in this order.',
        sendUrlDescription: "Show the monitor's URL to visitors.",
        customUrlDescription: 'Link visitors to this URL instead.',
        maintenanceVisibilityHoursDescription:
          'Hours a completed or cancelled maintenance window stays on the page.',
        homepageUrlDescription: 'Where the logo and title link to (http or https).',
        contactUrlDescription:
          'Contact link in the page header: an http(s) URL or mailto: address.',
        showValuesDescription: 'Show uptime percentages and response times to visitors.',
        defaultOpenDescription: 'Expanded when the page loads; visitors can still collapse it.',
        componentsDescription:
          'Components of the group: monitors, or static entries set by incidents.',
        componentTypeDescription:
          'monitor mirrors a monitor; static has no monitor and follows incidents and maintenance.',
        componentNameDescription:
          "Public name. Defaults to the monitor's public name, then its name. Required for static.",
        componentDescriptionDescription: 'Shown to visitors as a tooltip.',
        componentShowValuesDescription:
          'Show uptime and response time for this component (the page setting must be on too).',
        logoDescription: 'Shown in light mode, and in dark mode when there is no dark logo.',
        themeDescription:
          'auto lets visitors pick (system, light or dark); light and dark force that mode.',
        themePresetDescription: 'Built-in palette id, e.g. default, high-contrast, ocean.',
        themeOverridesDescription:
          'Colour overrides per mode: { "light": { "primary": "#0b5cad" }, "dark": { … }, "radius": "0.5rem" }. Hex, rgb(), hsl() or oklch() only.',
        bannerTextDescription: 'Replaces the automatic overall-status headline when set.',
        logoDarkDescription: 'Shown instead of the logo in dark mode.',
        faviconDescription: 'PNG, ICO or SVG; falls back to the logo.',
      },
      tags: {
        colorDescription: 'Hex colour of the chip, e.g. #2563EB.',
      },
      users: {
        superadminDescription:
          'Instance administrator: can access the Payload admin panel and every organization.',
        authProviderDescription:
          'How the account was created: password signup, the OIDC client, a social OAuth provider or SAML.',
        oidcIssuerDescription: 'Legacy: identities now live in Auth accounts.',
        oidcSubjectDescription: 'Legacy `sub` claim; identities now live in Auth accounts.',
        themeDescription: 'Colour scheme preference, applied on every device after sign-in.',
        twoFactorEnabledDescription: 'Managed from Settings → Account → Two-factor authentication.',
      },
    },
  },
}

export type AdminTranslationsObject = typeof adminTranslations.en
export type AdminTranslationKeys = NestedKeysStripped<AdminTranslationsObject>

/**
 * `label` / `description` function for a `marmot:` key, type-checked against the catalogue.
 * `vars` fill Payload-style `{{name}}` placeholders.
 */
export const adminT =
  (key: AdminTranslationKeys, vars?: Record<string, string>): AdminTextFunction =>
  ({ t }) =>
    (t as unknown as TFunction<AdminTranslationKeys>)(key, vars)

/**
 * Only needs `t`, so it fits every Payload slot that takes a function: field and option labels
 * (`LabelFunction`), field descriptions and collection descriptions (`EntityDescriptionFunction`).
 */
export type AdminTextFunction = (args: { t: unknown }) => string

/**
 * `admin.group` label in every admin language. Payload takes a static `{ [language]: label }`
 * map here rather than a function, so it is built from the catalogue above.
 */
export const adminGroup = (
  group: keyof AdminTranslationsObject['marmot']['groups'],
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(adminTranslations).map(([language, t]) => [language, t.marmot.groups[group]]),
  )

export const adminI18n: Config['i18n'] = {
  supportedLanguages: { en },
  fallbackLanguage: 'en',
  translations: adminTranslations,
}
