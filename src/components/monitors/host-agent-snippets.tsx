'use client'

import { useTranslations } from 'next-intl'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { CopyButton } from './push-snippets'

export interface HostAgentSnippetsProps {
  /** Marmot's base URL (`NEXT_PUBLIC_SERVER_URL`). */
  serverUrl: string
  token: string
}

const IMAGE = 'ghcr.io/thinkhumandotdev/marmot:latest'

/** Copy-ready ways to start the host agent (#136): Docker, Compose and plain Node.js. */
export function buildHostAgentSnippets({ serverUrl, token }: HostAgentSnippetsProps) {
  return {
    docker: [
      'docker run -d --name marmot-host-agent --restart unless-stopped \\',
      '  --network host --pid host \\',
      '  -v /:/host:ro,rslave -e HOST_AGENT_ROOT=/host \\',
      '  -e MARMOT_ROLE=host-agent \\',
      `  -e MARMOT_URL=${serverUrl} \\`,
      `  -e MARMOT_HOST_TOKEN=${token} \\`,
      `  ${IMAGE}`,
    ].join('\n'),
    compose: [
      'curl -fsSLO https://raw.githubusercontent.com/thinkhumandotdev/marmot/main/docker/docker-compose.host-agent.yml',
      `MARMOT_URL=${serverUrl} MARMOT_HOST_TOKEN=${token} \\`,
      '  docker compose -f docker-compose.host-agent.yml up -d',
    ].join('\n'),
    node: [
      '# Node.js 20 or later; the agent is one file in the Marmot image',
      `docker run --rm --entrypoint cat ${IMAGE} /app/dist/server/host-agent.mjs > marmot-host-agent.mjs`,
      `MARMOT_ROLE=host-agent MARMOT_URL=${serverUrl} MARMOT_HOST_TOKEN=${token} \\`,
      '  node marmot-host-agent.mjs',
    ].join('\n'),
  }
}

type SnippetKey = keyof ReturnType<typeof buildHostAgentSnippets>

export function HostAgentSnippets(props: HostAgentSnippetsProps) {
  const t = useTranslations('monitors.host.panel')
  const snippets = buildHostAgentSnippets(props)
  const keys: SnippetKey[] = ['docker', 'compose', 'node']
  return (
    <Tabs defaultValue="docker" data-testid="host-agent-snippets">
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
              data-testid={`host-agent-snippet-${key}`}
            >
              {snippets[key]}
            </pre>
            <CopyButton text={snippets[key]} />
          </div>
          <p className="text-xs text-muted-foreground">{t(`hints.${key}`)}</p>
        </TabsContent>
      ))}
    </Tabs>
  )
}
