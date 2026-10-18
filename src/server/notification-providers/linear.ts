/**
 * Linear provider (#149): creates an issue when a monitor goes DOWN, comments on reminders,
 * comments and moves it to a completed workflow state on recovery (`./issue-tracker.ts`). Uses
 * the GraphQL API with a personal API key; `team` is the team key (`ENG`) or its id.
 */
import { z } from 'zod'

import { httpRequest } from './http'
import {
  issueTemplateFieldMeta,
  issueTemplateSchema,
  IssueGoneError,
  markdownBody,
  runIssueTracker,
  type IssueTrackerClient,
} from './issue-tracker'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const LINEAR_API_URL = 'https://api.linear.app/graphql'

export const linearConfigSchema = z.object({
  apiKey: z.string().min(1),
  team: z.string().trim().min(1),
  priority: z.enum(['0', '1', '2', '3', '4']).default('0'),
  doneState: z.string().optional(),
  ...issueTemplateSchema,
})

export type LinearConfig = z.infer<typeof linearConfigSchema>

export const linearFieldMeta: Record<keyof LinearConfig, NotificationFieldMeta> = {
  apiKey: {
    label: 'API key',
    secret: true,
    description: 'Settings → Security & access → Personal API keys.',
  },
  team: { label: 'Team', placeholder: 'ENG', description: 'Team key or team ID.' },
  priority: {
    label: 'Priority',
    options: { '0': 'No priority', '1': 'Urgent', '2': 'High', '3': 'Medium', '4': 'Low' },
  },
  doneState: {
    label: 'State on recovery',
    placeholder: 'Done',
    description: 'Workflow state the issue moves to; empty picks the team’s first completed state.',
  },
  ...issueTemplateFieldMeta,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const LINEAR_QUERIES = {
  teamByKey:
    'query MarmotTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }',
  team: 'query MarmotTeam($id: String!) { team(id: $id) { id } }',
  issueCreate:
    'mutation MarmotIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
  commentCreate:
    'mutation MarmotCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
  states:
    'query MarmotStates($id: String!) { team(id: $id) { states { nodes { id name type position } } } }',
  issueUpdate:
    'mutation MarmotIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
} as const

interface LinearState {
  id: string
  name: string
  type: string
  position: number
}

registerNotificationProvider({
  name: 'linear',
  label: 'Linear',
  group: 'generic',
  docsUrl: 'https://linear.app/developers/graphql',
  configSchema: linearConfigSchema,
  fieldMeta: linearFieldMeta,
  async send(ctx) {
    const config = linearConfigSchema.parse(ctx.config)

    /** One GraphQL call; GraphQL errors arrive with HTTP 200 and are thrown here. */
    const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      const response = await httpRequest(LINEAR_API_URL, {
        method: 'POST',
        json: { query, variables },
        headers: { Authorization: config.apiKey },
      })
      const result = (await response.json()) as { data?: T; errors?: { message?: string }[] }
      if (result.errors?.length) {
        throw new Error(
          `Linear API error: ${result.errors.map((e) => e.message ?? 'unknown').join('; ')}`,
        )
      }
      if (!result.data) throw new Error('Linear API returned no data')
      return result.data
    }

    /** Team id: `team` itself when it is an id, else looked up by key (once per send). */
    let teamId: string | null = UUID.test(config.team) ? config.team : null
    const resolveTeam = async (): Promise<string> => {
      if (teamId) return teamId
      const data = await graphql<{ teams: { nodes: { id: string }[] } }>(LINEAR_QUERIES.teamByKey, {
        key: config.team.toUpperCase(),
      })
      const id = data.teams.nodes[0]?.id
      if (!id) throw new Error(`Linear team "${config.team}" not found`)
      teamId = id
      return teamId
    }

    const comment = async (issueId: string, body: string) => {
      let data: { commentCreate: { success: boolean } }
      try {
        data = await graphql(LINEAR_QUERIES.commentCreate, { input: { issueId, body } })
      } catch (error) {
        // A deleted issue: `Entity not found: Issue`.
        if (error instanceof Error && /entity not found/i.test(error.message)) {
          throw new IssueGoneError(error.message)
        }
        throw error
      }
      if (!data.commentCreate.success) throw new Error('Linear did not create the comment')
    }

    const client: IssueTrackerClient = {
      target: config.team,
      async open(text) {
        const priority = Number(config.priority)
        const data = await graphql<{
          issueCreate: { success: boolean; issue: { id: string } | null }
        }>(LINEAR_QUERIES.issueCreate, {
          input: {
            teamId: await resolveTeam(),
            title: text.title,
            description: markdownBody(text),
            ...(priority ? { priority } : {}),
          },
        })
        const id = data.issueCreate.issue?.id
        if (!data.issueCreate.success || !id) throw new Error('Linear did not create the issue')
        return id
      },
      async comment(id, text) {
        await comment(id, markdownBody(text))
      },
      async close(id, text) {
        await comment(id, markdownBody(text))
        const data = await graphql<{ team: { states: { nodes: LinearState[] } } | null }>(
          LINEAR_QUERIES.states,
          { id: await resolveTeam() },
        )
        const states = data.team?.states.nodes ?? []
        const wanted = config.doneState?.trim().toLowerCase()
        const state = wanted
          ? states.find((s) => s.name.toLowerCase() === wanted)
          : states.filter((s) => s.type === 'completed').sort((a, b) => a.position - b.position)[0]
        if (!state) {
          throw new Error(
            wanted
              ? `Linear team has no workflow state "${config.doneState}"`
              : 'Linear team has no completed workflow state',
          )
        }
        const updated = await graphql<{ issueUpdate: { success: boolean } }>(
          LINEAR_QUERIES.issueUpdate,
          { id, input: { stateId: state.id } },
        )
        if (!updated.issueUpdate.success) throw new Error('Linear did not update the issue')
      },
      async verify() {
        if (!UUID.test(config.team)) {
          await resolveTeam()
          return
        }
        const data = await graphql<{ team: { id: string } | null }>(LINEAR_QUERIES.team, {
          id: config.team,
        })
        if (!data.team) throw new Error(`Linear team "${config.team}" not found`)
      },
    }
    return runIssueTracker(ctx, client)
  },
})
