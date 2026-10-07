/**
 * The Marmot GitHub Action (#118, `action/action.yml`): `run` checks monitors now and fails the job
 * when one is down; `apply` plans or applies a monitors-as-code file. It reuses the CLI's core
 * (`src/cli/core`: API client, plan, apply) and is bundled into `action/dist/index.mjs` by
 * `scripts/build-action.mjs`. See docs/GitHub-Action.md.
 */
import { ApplyError, applyPlan } from '../cli/core/apply'
import { ApiError, MarmotClient } from '../cli/core/client'
import { planMonitors, type PreparedPlan } from '../cli/core/plan'
import { parseSpecText, readSpecDocument, SpecError } from '../cli/core/spec'
import { loadState } from '../cli/commands/monitors'
import { CLI_VERSION } from '../cli/context'
import { t } from '../cli/text'
import { checksExitCode, keysFromFile, runChecks, type CheckRow } from './checks'
import { annotation, mask, setOutputs, writeSummary, type ActionIo } from './github'
import { InputError, readInputs, type ActionInputs } from './inputs'
import { applyMarkdown, checksMarkdown, errorMarkdown, planDiff, totals } from './summary'

const createClient = (inputs: ActionInputs, io: ActionIo) =>
  new MarmotClient({
    url: inputs.url,
    apiKey: inputs.apiKey,
    org: inputs.org,
    fetch: io.fetch,
    userAgent: `marmot-action/${CLI_VERSION}`,
  })

async function readConfig(io: ActionIo, file: string): Promise<string> {
  try {
    return await io.readFile(file)
  } catch (error) {
    throw new InputError(
      t('errors.fileUnreadable', { file, reason: error instanceof Error ? error.message : '' }),
    )
  }
}

async function runMode(inputs: ActionInputs, io: ActionIo): Promise<number> {
  const refs =
    inputs.monitors.length > 0
      ? inputs.monitors
      : keysFromFile(await readConfig(io, inputs.config as string))
  if (refs.length === 0) throw new InputError(t('action.noTargets'))
  io.stdout(`${t('action.checking', { count: refs.length, url: inputs.url })}\n`)

  const rows: CheckRow[] = await runChecks(createClient(inputs, io), refs, {
    failOnDegraded: inputs.failOnDegraded,
    sleep: io.sleep,
    log: (message) => io.stdout(`${message}\n`),
  })
  for (const row of rows) {
    const line = `${row.verdict.toUpperCase().padEnd(4)}  ${row.key ?? row.ref}  ${row.status}  ${row.message}`
    io.stdout(`${line}\n`)
    const assertions = row.assertions.filter((line) => line !== row.message)
    for (const assertion of assertions) io.stdout(`      ${assertion}\n`)
    if (row.verdict === 'fail') {
      const monitor = row.name ?? row.ref
      io.stdout(
        annotation(
          'error',
          [row.message, ...assertions].filter(Boolean).join('\n'),
          t('action.checkFailed', { monitor, message: row.status }),
        ),
      )
    } else if (row.note) {
      io.stdout(annotation('warning', row.note, row.name ?? row.ref))
    }
  }
  await writeSummary(io, checksMarkdown(rows, inputs.url))
  const count = totals(rows)
  await setOutputs(io, {
    result: count.failed > 0 ? 'failed' : 'passed',
    passed: String(count.passed),
    failed: String(count.failed),
    skipped: String(count.skipped),
    json: JSON.stringify(rows),
  })
  const code = checksExitCode(rows)
  if (code !== 0) io.stdout(annotation('error', t('action.failedChecks', { count: count.failed })))
  return code
}

async function applyMode(inputs: ActionInputs, io: ActionIo): Promise<number> {
  const file = inputs.config as string
  const { document, warnings } = readSpecDocument(parseSpecText(await readConfig(io, file)), io.env)
  const client = createClient(inputs, io)
  const prepared: PreparedPlan = planMonitors(document, await loadState(client), {
    prune: inputs.prune,
  })
  const { plan } = prepared
  plan.warnings.unshift(...warnings)
  io.stdout(`${planDiff(plan)}\n`)
  for (const warning of plan.warnings) io.stdout(annotation('warning', warning, 'Marmot'))

  const changes = plan.summary.create + plan.summary.update + plan.summary.delete
  const outputs = {
    changes: String(changes + plan.createTags.length),
    plan: planDiff(plan),
    'dry-run': String(inputs.dryRun),
  }
  const dryRunNote = inputs.dryRunEvent
    ? t('action.dryRunAuto', { event: inputs.dryRunEvent })
    : null
  if (inputs.dryRun || changes + plan.createTags.length === 0) {
    await writeSummary(
      io,
      applyMarkdown({ plan, dryRun: inputs.dryRun, dryRunNote, applied: null, error: null }, file),
    )
    if (inputs.dryRun) io.stdout(`${t('action.dryRunNote')}${dryRunNote ? ` ${dryRunNote}` : ''}\n`)
    await setOutputs(io, outputs)
    return 0
  }

  try {
    const applied = await applyPlan(client, prepared, {
      onChange: (change) =>
        io.stdout(`${t('apply.progress', { action: change.action, key: change.key })}\n`),
    })
    const done = t('action.applied', {
      created: applied.created.length,
      updated: applied.updated.length,
      deleted: applied.deleted.length,
    })
    io.stdout(`${done}\n`)
    await writeSummary(
      io,
      applyMarkdown({ plan, dryRun: false, dryRunNote, applied, error: null }, file),
    )
    await setOutputs(io, outputs)
    return 0
  } catch (error) {
    if (!(error instanceof ApplyError)) throw error
    const issues = error.cause instanceof ApiError ? error.cause.issues : []
    const message = [
      t('action.applyFailed', { key: error.change?.key ?? '—', message: error.message }),
      ...issues.map((issue) => `${issue.path}: ${issue.message}`),
      t('apply.partial', {
        created: error.result.created.length,
        updated: error.result.updated.length,
        deleted: error.result.deleted.length,
      }),
    ].join('\n')
    io.stdout(annotation('error', message, t('action.applyTitle')))
    await writeSummary(
      io,
      applyMarkdown({ plan, dryRun: false, dryRunNote, applied: null, error: message }, file),
    )
    await setOutputs(io, outputs)
    return 1
  }
}

/** Runs the action; returns the process exit code (0 success, 1 failure). */
export async function runAction(io: ActionIo): Promise<number> {
  let inputs: ActionInputs | null = null
  try {
    inputs = readInputs(io.env)
    io.stdout(mask(inputs.apiKey))
    return inputs.mode === 'run' ? await runMode(inputs, io) : await applyMode(inputs, io)
  } catch (error) {
    const title = inputs?.mode === 'apply' ? t('action.applyTitle') : t('action.checksTitle')
    let lines: string[]
    if (error instanceof SpecError) {
      lines = [
        t('action.invalidFile'),
        ...error.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`),
      ]
    } else if (error instanceof ApiError) {
      lines =
        error.status === 0
          ? [t('action.networkError', { url: inputs?.url ?? '', message: error.message })]
          : [
              t('action.apiError', { status: error.status, message: error.message }),
              ...error.issues.map((issue) => `${issue.path}: ${issue.message}`),
              ...(error.status === 401 ? [t('errors.unauthorized')] : []),
            ]
    } else {
      lines = [error instanceof Error ? error.message : String(error)]
    }
    io.stdout(annotation('error', lines.join('\n'), title))
    await writeSummary(io, errorMarkdown(title, lines))
    return 1
  }
}
