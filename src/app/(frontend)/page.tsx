import { headers as getHeaders } from 'next/headers.js'
import Link from 'next/link'
import { getPayload } from 'payload'
import React from 'react'

import config from '@payload-config'

export default async function HomePage() {
  const headers = await getHeaders()
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers })

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-6 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Marmot</h1>
      <p className="text-lg text-muted-foreground">
        Self-hosted status monitor for teams.{' '}
        {user ? `Signed in as ${user.email}.` : 'Not signed in.'}
      </p>
      <div className="flex gap-4 text-sm">
        <Link className="underline" href="/admin">
          Admin panel
        </Link>
        <Link className="underline" href="/api/health">
          Health
        </Link>
      </div>
    </main>
  )
}
