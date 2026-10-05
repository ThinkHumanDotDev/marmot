/**
 * Next.js client instrumentation: runs once before the app hydrates. Initialises PostHog only when
 * the operator set `NEXT_PUBLIC_POSTHOG_KEY`, opted out until the visitor grants consent
 * (`src/components/consent`). Requests go to the same-origin `/ph` proxy (rewritten to
 * `NEXT_PUBLIC_POSTHOG_HOST` in `next.config.ts`), so no third-party host is contacted directly.
 */
import posthog from 'posthog-js'

import {
  analyticsKey,
  POSTHOG_PROXY_PATH,
  posthogUiHost,
  sanitizeCaptureResult,
} from '@/lib/analytics-config'

const key = analyticsKey()

if (key) {
  posthog.init(key, {
    api_host: POSTHOG_PROXY_PATH,
    ui_host: posthogUiHost(process.env.NEXT_PUBLIC_POSTHOG_HOST),
    // Nothing leaves the browser until `setAnalyticsConsent(true)`; honour Do Not Track as a refusal.
    opt_out_capturing_by_default: true,
    opt_out_persistence_by_default: true,
    respect_dnt: true,
    // Only identified users get a person profile; anonymous pageviews stay anonymous.
    person_profiles: 'identified_only',
    // Everything below is explicit: no automatic collection of any kind.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    // No feature flags / remote config round-trips and no extra scripts from the PostHog CDN.
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    // Strip URLs, referrers and hosts from every event (see `routePattern`).
    before_send: sanitizeCaptureResult,
  })
}
