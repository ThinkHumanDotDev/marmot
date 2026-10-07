'use client'

import { Check, Copy } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PUSH_BODY_LIMIT_BYTES } from '@/lib/push-schedule'

export interface PushSnippetsProps {
  /** `https://…/api/push/<token>` */
  url: string
  /** Crontab expression for the crontab example. */
  cron: string
  /** Zone of a cron schedule (`CRON_TZ` line), `null` for interval schedules. */
  cronTimeZone: string | null
}

const CURL = 'curl -fsS -m 10 --retry 5 -o /dev/null'

/** Copy-ready commands: the URL, curl calls for each signal, a bash wrapper and a crontab line. */
export function buildPushSnippets({ url, cron, cronTimeZone }: PushSnippetsProps) {
  const limit = PUSH_BODY_LIMIT_BYTES
  return {
    url,
    curl: [
      '# success',
      `${CURL} "${url}"`,
      '# start, failure, exit code of the previous command',
      `${CURL} "${url}/start"`,
      `${CURL} "${url}/fail?msg=disk%20full"`,
      `${CURL} "${url}/$?"`,
      `# output as a log entry (the first ${limit} bytes are kept)`,
      `my-job 2>&1 | tail -c ${limit} | ${CURL} --data-binary @- "${url}/log"`,
    ].join('\n'),
    wrapper: [
      '#!/usr/bin/env bash',
      '# marmot-run.sh <command> [args...]',
      `url="${url}"`,
      'rid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)"',
      `${CURL} "$url/start?rid=$rid"`,
      'output="$("$@" 2>&1)"',
      'code=$?',
      'printf \'%s\\n\' "$output"',
      `printf '%s' "$output" | tail -c ${limit} |`,
      `  ${CURL} --data-binary @- "$url/$code?rid=$rid"`,
      'exit "$code"',
    ].join('\n'),
    crontab: [
      ...(cronTimeZone ? [`CRON_TZ=${cronTimeZone}`] : []),
      `${cron} /usr/local/bin/marmot-run.sh /path/to/job.sh`,
    ].join('\n'),
  }
}

type SnippetKey = keyof ReturnType<typeof buildPushSnippets>

function CopyButton({ text }: { text: string }) {
  const t = useTranslations('monitors.push.panel')
  const [copied, setCopied] = React.useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed'))
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="absolute top-1 right-1 size-7"
      onClick={copy}
      aria-label={copied ? t('copied') : t('copy')}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </Button>
  )
}

export function PushSnippets(props: PushSnippetsProps) {
  const t = useTranslations('monitors.push.panel')
  const snippets = buildPushSnippets(props)
  const keys: SnippetKey[] = ['url', 'curl', 'wrapper', 'crontab']
  const hints: Partial<Record<SnippetKey, string>> = {
    wrapper: t('wrapperHint'),
    crontab: t('crontabHint'),
  }
  return (
    <Tabs defaultValue="url" data-testid="push-snippets">
      <TabsList>
        {keys.map((key) => (
          <TabsTrigger key={key} value={key}>
            {t(`tabs.${key}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      {keys.map((key) => (
        <TabsContent key={key} value={key} className="flex flex-col gap-2">
          <div className="relative">
            <pre
              className="overflow-x-auto rounded-md bg-muted py-2 pr-10 pl-3 text-xs"
              data-testid={`push-snippet-${key}`}
            >
              {snippets[key]}
            </pre>
            <CopyButton text={snippets[key]} />
          </div>
          {hints[key] && <p className="text-xs text-muted-foreground">{hints[key]}</p>}
        </TabsContent>
      ))}
    </Tabs>
  )
}
