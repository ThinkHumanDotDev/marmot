import type { PublicConfig } from '@/server/status-pages/public'
import { statusPagePath } from '@/server/status-pages/urls'

/**
 * What every public HTML page of a status page renders besides its content: the credentialed
 * manifest link of protected pages, the page's custom CSS and its Google Analytics tag.
 */
export function StatusPageExtras({
  config,
  restricted,
}: {
  config: Pick<PublicConfig, 'slug' | 'customCSS' | 'googleAnalyticsId'>
  restricted: boolean
}) {
  const gaId = config.googleAnalyticsId?.trim()
  return (
    <>
      {restricted && (
        // Browsers fetch manifests without cookies unless asked to; the manifest needs the cookie.
        <link
          rel="manifest"
          href={`${statusPagePath(config.slug)}/manifest.json`}
          crossOrigin="use-credentials"
        />
      )}
      {config.customCSS && (
        // Operators own their status page; custom CSS is a documented feature (as in Uptime Kuma).
        <style data-custom-css dangerouslySetInnerHTML={{ __html: config.customCSS }} />
      )}
      {gaId && /^[A-Z0-9-]+$/i.test(gaId) && (
        <>
          <script async src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} />
          <script
            dangerouslySetInnerHTML={{
              __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${gaId}');`,
            }}
          />
        </>
      )}
    </>
  )
}
