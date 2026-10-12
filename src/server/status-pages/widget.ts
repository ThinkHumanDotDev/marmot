/**
 * The embeddable status widget (#109): `GET /status/:slug/widget.js` answers a dependency-free
 * script that renders a status pill ("All Systems Operational", …) right after its `<script>`
 * element, linking to the page. It reads the page's cached `status.json` (Statuspage-compatible,
 * #108) without credentials and re-reads it on the page's auto-refresh interval.
 *
 * Options are `data-` attributes of the script element: `data-theme="light|dark|auto"` and
 * `data-size="sm|md|lg"`. The pill lives in a shadow root, so the host site's CSS cannot break it.
 *
 * Only public pages have a widget: protected pages (password, email domain, IP allow-list) answer
 * 404, so their status never reaches another site through it.
 */
import type { Payload } from 'payload'

import { MIN_PUBLIC_MAX_AGE } from './public-api'
import { isProtectedPage } from './access'
import { findPublishedStatusPage } from './public'
import { statusPageLinksFor } from './urls'

/** `max-age` of the script itself (it only carries the page's URLs, title and interval). */
export const WIDGET_MAX_AGE = 300

export interface WidgetConfig {
  /** The page, opened by the pill. */
  url: string
  /** `status.json` of the page. */
  api: string
  title: string
  /** Seconds between refreshes; 0 never refreshes. */
  interval: number
}

/** Refresh interval of the widget: the page's own (at least the 30 s `status.json` is cached for). */
export function widgetInterval(autoRefreshInterval: number | null | undefined): number {
  const interval = Math.floor(autoRefreshInterval ?? 0)
  return interval > 0 ? Math.max(MIN_PUBLIC_MAX_AGE, interval) : 0
}

/** JSON embedded in the script, with `<`, `>` and `&` escaped (line separators are valid since ES2019). */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const STYLE =
  ':host{display:inline-block;vertical-align:middle}' +
  'a{display:inline-flex;align-items:center;gap:.5em;padding:.35em .85em;border:1px solid;border-radius:999px;' +
  'font:500 var(--s,14px)/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-decoration:none;white-space:nowrap}' +
  'a:hover,a:focus-visible{text-decoration:underline}' +
  '.light{background:#fff;color:#1c1a18;border-color:#e2ded6}' +
  '.dark{background:#1c1a18;color:#f7f5f1;border-color:#3d3833}' +
  'i{flex:none;width:.6em;height:.6em;border-radius:50%;background:var(--c,#9ca3af)}'

/** The widget script for `config`. Kept small (well under 5 KB gzipped) and ES5-only. */
export function buildWidgetScript(config: WidgetConfig): string {
  return `/* Marmot status widget */
(function () {
  var c = ${scriptJson(config)};
  var s = document.currentScript;
  if (!s || !s.parentNode) return;
  var d = s.dataset || {};
  var colors = { none: '#16a34a', minor: '#d97706', major: '#ea580c', critical: '#dc2626' };
  var sizes = { sm: '12px', md: '14px', lg: '16px' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var host = document.createElement('span');
  host.setAttribute('data-marmot-status-widget', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML = ${scriptJson(`<style>${STYLE}</style>`)} +
    '<a target="_blank" rel="noopener noreferrer" part="pill"><i></i><span aria-live="polite"></span></a>';
  var a = root.querySelector('a');
  var label = root.querySelector('span');
  a.href = c.url;
  a.style.setProperty('--s', sizes[d.size] || sizes.md);
  label.textContent = c.title;
  function theme() {
    var dark = d.theme === 'dark' || (d.theme === 'auto' && mq && mq.matches);
    a.className = dark ? 'dark' : 'light';
  }
  theme();
  s.parentNode.insertBefore(host, s.nextSibling);
  var timer = 0;
  function load() {
    if (!host.isConnected) return clearInterval(timer);
    fetch(c.api, { credentials: 'omit', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var st = j && j.status;
        if (!st || typeof st.description !== 'string') return;
        a.setAttribute('data-indicator', String(st.indicator));
        a.style.setProperty('--c', colors[st.indicator] || '#9ca3af');
        a.title = c.title;
        label.textContent = st.description;
        theme();
      })
      .catch(function () {});
  }
  load();
  if (c.interval > 0) timer = setInterval(load, c.interval * 1000);
})();
`
}

const notFoundScript = (): Response =>
  new Response('/* Marmot: no public status page here. */\n', {
    status: 404,
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })

/** `GET /status/:slug/widget.js`. */
export async function serveStatusWidget(
  payload: Payload,
  request: Request,
  slug: string,
): Promise<Response> {
  const page = await findPublishedStatusPage(payload, slug)
  if (!page || isProtectedPage(page)) return notFoundScript()

  const links = statusPageLinksFor(page, request)
  const script = buildWidgetScript({
    url: links.page,
    api: links.api('status'),
    title: page.title,
    interval: widgetInterval(page.autoRefreshInterval),
  })
  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': `public, max-age=${WIDGET_MAX_AGE}, stale-while-revalidate=${WIDGET_MAX_AGE}`,
      // Loadable from any site, also with `crossorigin` and under COEP.
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Robots-Tag': 'noindex',
    },
  })
}
