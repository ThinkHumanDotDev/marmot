import Link from 'next/link'
import type * as React from 'react'

/** Frame of the confirm / manage / unsubscribe pages: the page's logo and title, then the card. */
export function SubscriptionShell({
  logo,
  title,
  backHref,
  backLabel,
  children,
}: {
  logo: string | null
  title: string
  backHref: string
  backLabel: string
  children: React.ReactNode
}) {
  return (
    <main
      id="status-page-subscription"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element -- user upload, arbitrary size
          <img
            src={logo}
            alt=""
            className="size-14 rounded-lg object-contain"
            width={56}
            height={56}
          />
        )}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">{children}</div>
      <Link
        href={backHref}
        className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {backLabel}
      </Link>
    </main>
  )
}
