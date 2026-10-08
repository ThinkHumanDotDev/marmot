/**
 * Shared HTML frame of Marmot's own emails (status page subscriber mail, account mail such as
 * email verification). Inline styles only: mail clients ignore `<style>` blocks.
 */
import { escapeHtml } from '@/lib/markdown'

/** A call-to-action link styled as a button. `url` and `label` are escaped here. */
export const emailButton = (url: string, label: string) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1c1a18;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`

/** The card around `body` (already escaped HTML) with `footer` (escaped HTML) underneath. */
export const emailLayout = (body: string, footer: string) =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1a18"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px 28px;line-height:1.5;font-size:15px">${body}</div><div style="max-width:560px;margin:12px auto 0;font-size:12px;color:#6b6760;line-height:1.5">${footer}</div></body></html>`
