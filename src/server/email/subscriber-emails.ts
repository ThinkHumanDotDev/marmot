/**
 * Emails sent to status page subscribers (#104): the double opt-in confirmation, the "already
 * subscribed" reminder (sent instead of an error so sign-ups never reveal who is subscribed) and
 * the incident / maintenance announcements. Text comes from `email.subscriptions.*` in the
 * subscriber's locale; every message carries the manage and unsubscribe links, and
 * `subscriberEmailHeaders` adds RFC 2369 / RFC 8058 one-click `List-Unsubscribe` headers.
 */
import type { Locale } from '@/i18n/locales'
import { escapeHtml, renderMarkdown } from '@/lib/markdown'
import { serverTranslator } from '@/server/i18n'
import { emailButton as button, emailLayout as layout } from '@/server/email/layout'
import type { Announcement, RenderContext } from '@/server/status-pages/subscribers/content'
import { bodyLines, headline } from '@/server/status-pages/subscribers/content'
import type { SubscriptionLinks } from '@/server/status-pages/subscribers/links'

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

const footerHtml = (siteName: string, links: SubscriptionLinks, locale: Locale) => {
  const t = serverTranslator(locale)
  return `${escapeHtml(t('email.subscriptions.footer', { siteName }))}<br/><a href="${escapeHtml(links.manageUrl)}" style="color:#6b6760">${escapeHtml(t('email.subscriptions.manage'))}</a> · <a href="${escapeHtml(links.unsubscribeUrl)}" style="color:#6b6760">${escapeHtml(t('email.subscriptions.unsubscribe'))}</a>`
}

const footerText = (siteName: string, links: SubscriptionLinks, locale: Locale) => {
  const t = serverTranslator(locale)
  return [
    t('email.subscriptions.footer', { siteName }),
    t('email.subscriptions.manageLink', { url: links.manageUrl }),
    t('email.subscriptions.unsubscribeLink', { url: links.unsubscribeUrl }),
  ].join('\n')
}

/** Double opt-in: the link leads to a page with a confirm button (scanners do not confirm). */
export function renderSubscriptionConfirmEmail({
  siteName,
  links,
  locale,
}: {
  siteName: string
  links: SubscriptionLinks
  locale: Locale
}): RenderedEmail {
  const t = serverTranslator(locale)
  const intro = (strong: (chunks: string) => string, name: string) =>
    t.markup('email.subscriptions.confirm.intro', { siteName: name, strong })
  return {
    subject: t('email.subscriptions.confirm.subject', { siteName }),
    text: [
      intro((chunks) => chunks, siteName),
      t('email.subscriptions.confirm.link', { url: links.confirmUrl }),
      t('email.subscriptions.confirm.ignore'),
    ].join('\n\n'),
    html: layout(
      `<p>${intro((chunks) => `<strong>${chunks}</strong>`, escapeHtml(siteName))}</p>${button(links.confirmUrl, t('email.subscriptions.confirm.button'))}<p style="color:#6b6760;font-size:13px">${escapeHtml(t('email.subscriptions.confirm.ignore'))}</p>`,
      '',
    ),
  }
}

/** Sent when an address that is already subscribed signs up again. */
export function renderAlreadySubscribedEmail({
  siteName,
  links,
  locale,
}: {
  siteName: string
  links: SubscriptionLinks
  locale: Locale
}): RenderedEmail {
  const t = serverTranslator(locale)
  const intro = (strong: (chunks: string) => string, name: string) =>
    t.markup('email.subscriptions.already.intro', { siteName: name, strong })
  return {
    subject: t('email.subscriptions.already.subject', { siteName }),
    text: [
      intro((chunks) => chunks, siteName),
      t('email.subscriptions.manageLink', { url: links.manageUrl }),
      t('email.subscriptions.unsubscribeLink', { url: links.unsubscribeUrl }),
      t('email.subscriptions.already.ignore'),
    ].join('\n\n'),
    html: layout(
      `<p>${intro((chunks) => `<strong>${chunks}</strong>`, escapeHtml(siteName))}</p>${button(links.manageUrl, t('email.subscriptions.manage'))}<p style="color:#6b6760;font-size:13px">${escapeHtml(t('email.subscriptions.already.ignore'))}</p>`,
      `<a href="${escapeHtml(links.unsubscribeUrl)}" style="color:#6b6760">${escapeHtml(t('email.subscriptions.unsubscribe'))}</a>`,
    ),
  }
}

/** An incident or maintenance announcement. */
export function renderAnnouncementEmail(
  announcement: Announcement,
  links: SubscriptionLinks,
  ctx: RenderContext,
): RenderedEmail {
  const t = serverTranslator(ctx.locale)
  const head = headline(announcement, ctx.locale)
  const lines = bodyLines(announcement, ctx)
  const message = announcement.message.trim()
  return {
    subject: t('email.subscriptions.subject', {
      siteName: announcement.siteName,
      headline: head,
      title: announcement.title,
    }),
    text: [
      `${head}: ${announcement.title}`,
      lines.join('\n'),
      message,
      t('email.subscriptions.viewPageLink', { url: announcement.url }),
      '--',
      footerText(announcement.siteName, links, ctx.locale),
    ]
      .filter(Boolean)
      .join('\n\n'),
    html: layout(
      `<p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b6760">${escapeHtml(head)}</p><h1 style="margin:4px 0 12px;font-size:20px">${escapeHtml(announcement.title)}</h1>${lines.map((line) => `<p style="margin:4px 0;color:#3d3a35">${escapeHtml(line)}</p>`).join('')}${message ? `<div style="margin-top:16px">${renderMarkdown(message)}</div>` : ''}${button(announcement.url, t('email.subscriptions.viewPage'))}`,
      footerHtml(announcement.siteName, links, ctx.locale),
    ),
  }
}

/**
 * `List-Unsubscribe` (the one-click endpoint and the unsubscribe page) and `List-Unsubscribe-Post`
 * (RFC 8058), so mail clients offer an unsubscribe button that works without opening a page.
 */
export const subscriberEmailHeaders = (links: SubscriptionLinks): Record<string, string> => ({
  'List-Unsubscribe': `<${links.oneClickUrl}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
})
