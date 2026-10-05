'use client'

import { Globe, Plus, Trash2 } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'

import { normalizeHostname, validateHostname } from '@/collections/StatusPages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId } from '../api'

export function DomainsPanel({
  orgId,
  page,
  onSaved,
  canEdit,
}: {
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
}) {
  const [hostnames, setHostnames] = React.useState<string[]>(() =>
    (page.domains ?? []).map((d) => d.hostname),
  )
  const [input, setInput] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const serverHost = typeof window !== 'undefined' ? window.location.host : 'your Marmot host'
  const dirty =
    JSON.stringify(hostnames) !== JSON.stringify((page.domains ?? []).map((d) => d.hostname))

  function add(event: React.FormEvent) {
    event.preventDefault()
    const host = normalizeHostname(input)
    const valid = validateHostname(host)
    if (valid !== true) return setError(valid)
    if (hostnames.includes(host)) return setError('Already listed.')
    setHostnames([...hostnames, host])
    setInput('')
    setError(null)
  }

  async function save() {
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, {
        domains: hostnames.map((hostname) => ({ hostname })),
      })
      onSaved(doc)
      setHostnames((doc.domains ?? []).map((d) => d.hostname))
      toast.success('Domains saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save domains')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <div>
          <Label className="text-base">Custom domains</Label>
          <p className="text-sm text-muted-foreground">
            Serve this page at the root of your own hostname, e.g. <code>status.example.com</code>.
          </p>
        </div>

        <form onSubmit={add} className="flex items-start gap-2">
          <div className="flex-1">
            <Input
              aria-label="Hostname"
              placeholder="status.example.com"
              value={input}
              disabled={!canEdit}
              onChange={(e) => {
                setInput(e.target.value)
                setError(null)
              }}
            />
            {error && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" variant="outline" disabled={!canEdit || !input.trim()}>
            <Plus /> Add
          </Button>
        </form>

        {hostnames.length === 0 ? (
          <p className="rounded-xl border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">
            No custom domains. The page is reachable at <code>/status/{page.slug}</code>.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {hostnames.map((host) => (
              <li key={host} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="inline-flex items-center gap-2 font-mono text-sm">
                  <Globe className="size-4 text-muted-foreground" aria-hidden />
                  {host}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${host}`}
                  disabled={!canEdit}
                  onClick={() => setHostnames(hostnames.filter((h) => h !== host))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button type="button" disabled={!canEdit || !dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save domains'}
          </Button>
        </div>
      </div>

      <aside className="rounded-xl border bg-muted/40 p-4 text-sm">
        <h3 className="font-medium">DNS setup</h3>
        <ol className="mt-2 list-decimal space-y-2 pl-4 text-muted-foreground">
          <li>
            Create a <code>CNAME</code> record for the hostname pointing at{' '}
            <code className="text-foreground">{serverHost}</code>.
          </li>
          <li>Add the hostname here, save, and make sure the page is published.</li>
          <li>
            Your reverse proxy must obtain a certificate for the hostname (Caddy on-demand TLS is
            documented in <code>docs/status-pages.md</code>).
          </li>
        </ol>
      </aside>
    </div>
  )
}
