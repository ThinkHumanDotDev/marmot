'use client'

import { Building2, KeyRound } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ssoApi, type SsoLoginOption } from '@/lib/sso-api'

interface SsoLookupFormProps {
  next?: string
  /** Pre-resolved options (when the page was opened with `?org=<slug>`). */
  initialOptions?: SsoLoginOption[]
  initialOrganization?: string
}

const withNext = (path: string, next?: string) =>
  next ? `${path}?next=${encodeURIComponent(next)}` : path

/**
 * "Sign in with your organization": the user enters their work email (or organization slug); the
 * verified domain or slug maps to the organization's enabled connections, each rendered as a
 * "Continue with …" link that starts its flow.
 */
export function SsoLookupForm({ next, initialOptions, initialOrganization }: SsoLookupFormProps) {
  const [mode, setMode] = React.useState<'email' | 'organization'>(
    initialOrganization ? 'organization' : 'email',
  )
  const [value, setValue] = React.useState(initialOrganization ?? '')
  const [options, setOptions] = React.useState<SsoLoginOption[] | null>(initialOptions ?? null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const id = React.useId()

  async function lookup(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const { options } = await ssoApi.lookup(
        mode === 'email' ? { email: value.trim() } : { organization: value.trim() },
      )
      setOptions(options)
      if (options.length === 1) {
        window.location.assign(withNext(options[0].loginPath, next))
        return
      }
      if (options.length === 0) {
        setError(
          mode === 'email'
            ? 'No single sign-on is set up for that email domain. Sign in with your password, or ask your administrator.'
            : 'No single sign-on is set up for that organization.',
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not look that up.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {options && options.length > 1 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {options[0].organization.name} offers several ways to sign in:
          </p>
          {options.map((option) => (
            <Button key={option.id} asChild variant="outline" className="w-full">
              <a href={withNext(option.loginPath, next)} rel="nofollow">
                <KeyRound aria-hidden /> Continue with {option.name}
              </a>
            </Button>
          ))}
        </div>
      )}
      <form onSubmit={lookup} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>{mode === 'email' ? 'Work email' : 'Organization'}</Label>
          <Input
            id={id}
            type={mode === 'email' ? 'email' : 'text'}
            autoComplete={mode === 'email' ? 'email' : 'organization'}
            placeholder={mode === 'email' ? 'you@company.com' : 'organization-slug'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending || !value.trim()}>
          <Building2 aria-hidden /> {pending ? 'Looking up…' : 'Continue'}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            setMode((m) => (m === 'email' ? 'organization' : 'email'))
            setOptions(null)
            setError(null)
          }}
        >
          {mode === 'email' ? 'Use the organization name instead' : 'Use your work email instead'}
        </button>
      </form>
    </div>
  )
}
