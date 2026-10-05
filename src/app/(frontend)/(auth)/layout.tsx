import React from 'react'

/** Centered card layout for sign-in, sign-up and password flows. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10 text-foreground">
      {children}
      <p className="mt-10 text-xs text-muted-foreground">Marmot · self-hosted status monitoring</p>
    </main>
  )
}
