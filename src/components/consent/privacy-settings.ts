/**
 * Decoupled trigger for the consent preferences dialog. The user menu lives outside the consent
 * provider (and renders when analytics are off), so it fires a DOM event that
 * `ConsentBridge` turns into `setActiveUI('dialog')` when the provider is mounted.
 */
export const PRIVACY_SETTINGS_EVENT = 'marmot:privacy-settings'

export function openPrivacySettings(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(PRIVACY_SETTINGS_EVENT))
}
