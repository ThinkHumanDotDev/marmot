/**
 * Visitor theme choice on public status pages (theme toggle + the pre-paint script in
 * `src/app/status/[slug]/layout.tsx`). Shared by every status page on this origin, like a site-wide
 * preference. Absent = follow the system.
 */
export const STATUS_THEME_STORAGE_KEY = 'marmot:status-page-theme'

export const VISITOR_THEMES = ['system', 'light', 'dark'] as const
export type VisitorTheme = (typeof VISITOR_THEMES)[number]

/** Inline, pre-paint: applies the stored choice or the system preference. */
export const visitorThemeScript = `(function(){var p=null;try{p=localStorage.getItem('${STATUS_THEME_STORAGE_KEY}')}catch(e){}try{if(p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`
