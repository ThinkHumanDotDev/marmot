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
        pushSchedule: 'Push schedule',
        pushScheduleInterval: 'Interval',
        pushScheduleCron: 'Cron expression',
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
        assertions: 'Assertions',
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
        scopeDescription:
          'read: GET requests only (acts as a viewer). write: also mutations (acts as a member). Fixed at creation.',
      },
      webhookEndpoints: {
        description:
          'Outbound event webhooks of an organization. Manage them under Settings → Webhooks; the signing secret is shown once.',
        eventsDescription: 'Event types, group wildcards (incident.*) or * for every event.',
        consecutiveFailuresDescription:
          'Deliveries in a row that failed for good; the endpoint is disabled at WEBHOOK_DISABLE_AFTER_FAILURES.',
      },
      webhookDeliveries: {
        description:
          'Delivery log of outbound webhooks, pruned after WEBHOOK_DELIVERY_RETENTION_DAYS.',
      },
      auditLogs: {
        description:
          'Security events and changes to organization resources. Rows are written by the server and cannot be edited.',
        targetDescription: 'Affected record, e.g. monitor:42.',
        actorLabelDescription: 'Email or API key name at the time of the event.',
        changedFieldsDescription: 'Paths that changed; secret values are redacted in before/after.',
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
      locations: {
        description:
          'Self-hosted probe locations. Manage them under Settings → Locations; the token is shown once.',
        slugDescription:
          'Unique per organization; "local" is reserved for the workers of this server.',
        labelsDescription: 'Up to 20 metadata labels, e.g. region: eu-west.',
        tokenPrefixDescription: 'Public identifier of the current token (mp_<prefix>).',
        statusDescription:
          'unknown until an agent calls in; offline after PROBE_OFFLINE_AFTER seconds of silence.',
        agentDescription: 'Version, host name and platform the last agent reported.',
      },
      heartbeats: {
        organizationDescription: 'Denormalised from the monitor for org-scoped queries.',
        pingDescription: 'Response time in milliseconds (null when not measured).',
        durationDescription: 'Seconds since the previous heartbeat of this monitor.',
        importantDescription: 'True when the status changed compared to the previous heartbeat.',
        triggerDescription:
          'What started the check: "manual" for Check now; empty for scheduled checks and pushes.',
        assertionsDescription: 'Per-assertion results of this check (HTTP and DNS monitors).',
        timingDescription:
          'Request phases in ms: DNS, connect, TLS, time to first byte and transfer (HTTP and TCP monitors).',
        locationDescription: 'Probe location that ran the check; empty for the local workers.',
        probesDescription:
          'Per-probe results of a multi-location check (Globalping monitors): location, outcome and latency.',
      },
      pushEvents: {
        description:
          'Signals received by push monitors (success, fail, start, log) with their message and captured request body. The newest 100 per monitor are kept.',
        kindDescription: 'success, fail, start or log.',
        sourceDescription: 'How the signal arrived (http).',
        bodyDescription: 'First 10 000 bytes of the request body (the job output).',
        ridDescription: 'Run id pairing a start with its success or failure.',
        durationDescription: 'Run duration in milliseconds (start to success/failure).',
      },
      incidents: {
        organizationDescription: 'Derived from the status page.',
        publicIdDescription:
          'Short id of the public permalink (/events/incident/<id>). Assigned automatically.',
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
      statusPageViewers: {
        statusDescription: 'revoked: the visitor is signed out and cannot request new links.',
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
      monitorIncidents: {
        description:
          'Outages of monitors, opened by the engine on DOWN and resolved on recovery. Managed by the server.',
        statusDescription: 'open → acknowledged → resolved.',
        openKeyDescription: 'Uniqueness guard: one unresolved incident per monitor.',
        causeDescription: 'Message of the first DOWN heartbeat.',
        autoResolvedDescription: 'Resolved by the engine when the monitor recovered.',
        remindersSentDescription: 'Resend-interval reminders sent while the incident was open.',
        statusPageIncidentDescription: 'Public status-page incident created from this incident.',
        timelineDescription: 'What happened, oldest first.',
      },
      maintenanceOccurrences: {
        description:
          'Concrete windows of maintenances with their state and public update timeline. Managed by the server.',
        startDescription: 'Planned start of this window.',
        publicIdDescription:
          'Short id of the public permalink (/events/maintenance/<id>). Assigned automatically.',
        endDescription: 'Planned end; empty for manual maintenances.',
        remindersSentDescription: 'Reminder offsets (minutes) already sent or skipped.',
        updatesDescription: 'Public timeline: one entry per state change or posted update.',
      },
      monitors: {
        statusDescription: 'Maintained by the worker. Mirrors the latest heartbeat.',
        lastPushAtDescription:
          'Push monitors: time of the last success or failure reported to the push endpoint.',
        lastPushStatusDescription: 'Push monitors: outcome of that last success or failure.',
        pushRunsDescription:
          'Push monitors: runs announced with /start that have not reported success or failure yet.',
        pushScheduleDescription:
          'When pings are expected: every interval, or at the times of a cron expression.',
        pushCronDescription: 'Five-field cron expression, e.g. 0 2 * * * for 02:00 every day.',
        pushTimezoneDescription:
          "IANA time zone of the cron expression. SAME_AS_SERVER uses the organization's time zone.",
        pushGraceDescription:
          'Seconds a ping may be late (and a started run may take) before the monitor goes DOWN. Empty: 10 % of the interval, 60 s for cron.',
        pushMaxDurationDescription:
          'Optional: runs (from /start to success) longer than this many seconds are reported DOWN.',
        activeDescription: 'Paused monitors are not checked.',
        parentDescription: 'Group this monitor belongs to.',
        publicNameDescription: 'Name shown on status pages instead of the monitor name.',
        keyDescription:
          'Monitors-as-code key: `marmot monitors apply` manages the monitor with this key. Unique per organization.',
        tagsDescription: 'Tags (optionally with a value, e.g. env: prod) shown as chips.',
        notificationsDescription: 'Channels alerted when this monitor changes status.',
        locationsDescription:
          'Probe location that checks this monitor. Empty: the workers of this server (local).',
        weightDescription: 'Sort order on status pages.',
        proxyDescription: 'Send the request through this proxy (inactive proxies are skipped).',
        dockerContainerDescription: 'Container name or id.',
        portDescription: 'DNS monitors: port of the resolver (default 53).',
        intervalDescription: 'Seconds between checks (UI minimum 20).',
        retryIntervalDescription: 'Seconds between checks while pending (retrying).',
        maxRetriesDescription: 'Retries before the monitor is marked DOWN.',
        resendIntervalDescription: 'Re-notify every N consecutive DOWN beats (0 = never).',
        successThresholdDescription:
          'Consecutive successful checks a DOWN monitor needs before it is UP again (1 = the first one).',
        reminderBackoffDescription: 'Spacing of resend-interval reminders while DOWN.',
        reminderBackoff_none: 'Fixed (every resend interval)',
        reminderBackoff_linear: 'Linear (1×, 2×, 3× …)',
        reminderBackoff_exponential: 'Exponential (1×, 2×, 4× …)',
        maxRemindersDescription: 'Stop reminders after this many per incident (0 = unlimited).',
        recoveriesDescription: 'Successful checks counted so far towards the recovery threshold.',
        timeoutDescription: 'Request timeout in seconds (0 = 80% of the interval).',
        degradedAfterDescription:
          'Response time in ms above which a successful check is marked DEGRADED (empty or 0 = off).',
        settledStatusDescription:
          'Last status other than pending (decides transitions after retries).',
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
        assertionsDescription:
          'All must pass. HTTP monitors: status, header, textBody, jsonBody; DNS monitors: dnsRecord. At most 10 per kind.',
        assertionTargetDescription:
          'Header name, JSONata expression (jsonBody) or record type (dnsRecord).',
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
        globalpingProtocolDescription:
          'Ping: ICMP or TCP; HTTP: HTTP, HTTPS or HTTP2; DNS: UDP or TCP; traceroute: ICMP, TCP or UDP. Empty uses the default.',
        globalpingLocationsDescription:
          'Comma-separated Globalping locations, e.g. Europe, US+AWS, AS13335. Empty means anywhere.',
        globalpingSuccessRuleDescription:
          'all: every probe must succeed; any: one is enough; atLeast: the minimum below.',
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
        eventsDescription:
          'Events this channel is told about. Leave empty for the defaults (down, recovery, reminders, certificate and domain expiry).',
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
        groupClaimDescription:
          'OIDC claim or SAML attribute that lists the groups (default `groups`; dotted paths such as `realm_access.roles` work).',
        allowedGroupsDescription:
          'Comma-separated, case-insensitive. When set, only members of these groups can sign in through this connection.',
        groupRolesDescription:
          'Organization role per group, applied on every login; the highest matching role wins. The last owner is never demoted.',
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
        accessDescription:
          'password: visitors enter the page password. email-domain: visitors get a one-time link at an allowed email domain. ip-allowlist: only requests from the listed IP ranges.',
        passwordDescription:
          'Set or change the page password. Changing it signs every visitor out.',
        allowedEmailDomainsDescription:
          'Domains such as example.com; addresses at these domains can request a sign-in link.',
        allowedIpRangesDescription:
          'IPv4 or IPv6 addresses and CIDR ranges. Needs the trustProxy instance setting behind a reverse proxy.',
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
        pastIncidentsDaysDescription:
          'Days of past incidents listed on the page, grouped by day (0 hides the list). Older ones are on the history page.',
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
        subscriptionsEnabledDescription:
          'Show a Subscribe button and send incident and maintenance announcements to subscribers.',
        deliveryModeDescription:
          'review: every announcement waits as a draft until someone sends it; auto: sent at once.',
        subscriptionChannelsDescription: 'Channels visitors may subscribe with.',
        smsChannelDescription: 'Twilio notification channel whose credentials send the SMS.',
        smsMaxSegmentsDescription: 'Longer SMS are shortened to fit this many segments.',
        smsTemplatesDescription:
          'Optional SMS templates with {{ siteName }} {{ title }} {{ status }} {{ message }} {{ url }}.',
      },
      subscribers: {
        targetDescription: 'Email address, phone number (E.164), webhook URL or Slack webhook URL.',
        componentsDescription: 'Component ids of the page; empty means every component.',
        confirmedAtDescription: 'Unconfirmed self sign-ups receive nothing.',
        localeDescription: 'Language of the messages.',
        secretDescription: 'Signs every webhook delivery (X-Marmot-Signature).',
      },
      subscriberNotifications: {
        windowDescription: 'Maintenance window of the announcement.',
        channelsDescription: 'Channels the announcement went out on.',
      },
      tags: {
        colorDescription: 'Hex colour of the chip, e.g. #2563EB.',
      },
      templates: {
        kindDescription:
          'incident pre-fills a new incident, incident-update the incident update composer, maintenance the maintenance form, maintenance-update the maintenance update composer.',
        bodyDescription:
          'Markdown with placeholders in double braces (page, components, eta, …). Unfilled placeholders block publishing.',
        statusPageDescription:
          'Status page the default components belong to. Empty: the template is offered on every page.',
        componentsDescription: 'Default affected components (group row ids of the status page).',
        impactDescription: 'Overall impact when the template names no component.',
        durationDescription: 'Maintenance: default window length in minutes.',
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
