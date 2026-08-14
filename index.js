/**
 * dsh-ultracode — Claude Code "ultracode"-style session mode for DSH.
 *
 * While active, every model request is raised to the top reasoning effort the
 * selected model supports, and an orchestration policy section is included in
 * the system prompt so the agent fans substantive tasks out across parallel
 * subagents/workflows instead of grinding through one overloaded context.
 *
 * Durable state rides the command lifecycle events `dsh-commands` already
 * logs for every execution (`command/run` + `command/done`, both in the
 * harness's known event vocabulary): the last successful `/ultracode`
 * command decides the mode, so resume, fork, and cold transcript reads
 * reconstruct it without this plugin appending any custom event type. The
 * persistence read path refuses logs holding unknown event types unless each
 * such event is marked ignorable, and `Session.append()` offers no way for an
 * out-of-tree plugin to set that marker — so a plugin-owned event type would
 * poison every log it touches for readers without a registration surface.
 */
import { importHost } from './host.js'
import { installEffortOverride } from './effort.js'

export const name = 'ultracode'
export const inject = ['systemPrompt', 'llm']

const { createUserMessage } = await importHost('@deepseek-ai/dsh-llm')

let z
try {
  const zod = await importHost('zod')
  z = zod.z ?? zod.default ?? zod
} catch {
  z = undefined
}

const COMMAND = 'ultracode'

const DEFAULT_SECTION = `# Ultracode mode

Ultracode is active for this session: the user opted into maximum reasoning
effort and autonomous orchestration. Calibrate the machinery to the task.

- Gauge scope first. For focused work (a small edit, a quick question, a
  single-file fix), do it directly — orchestration overhead would only slow
  it down.
- For substantive work (multi-file features, large refactors, audits,
  migrations, cross-cutting debugging), orchestrate deliberately instead of
  grinding through one overloaded context:
  1. Decompose the objective into independent work items with clear success
     criteria, and keep a live todo list so progress stays visible.
  2. Fan out: launch parallel background subagent runs for independent items
     (research, per-module implementation, broad searches, test runs), and
     batch the launches in a single step rather than one at a time.
  3. For a long pipeline with ordered phases and joins, prefer one workflow
     call over hand-managed subagents.
  4. Reserve your own context for coordination: integrate results, resolve
     conflicts, and verify the outcome — run tests and linters, re-read the
     key diffs, and for risky changes dispatch a fresh reviewer subagent
     before declaring the work done.
- Report delegated work faithfully: if a subagent fails, stalls, or returns
  something doubtful, verify or redo it rather than papering over it.`

/** The mode one `/ultracode` invocation asks for, from its recorded args. */
function wantedFromArgs(args) {
  return args.trim() !== 'off'
}

/**
 * Whether ultracode is active after the first `end` events: the last
 * `/ultracode` command whose `command/done` settled `success` wins (pairing
 * by commandId). A run with unrecorded args cannot state an intent and a run
 * that settled `error` never changed anything, so both leave the fold alone.
 */
export function foldUltracode(events, end = events.length) {
  let active = false
  const open = new Map()
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index += 1
    if (event.type === 'command/run') {
      if (event.data.name !== COMMAND || typeof event.data.args !== 'string') continue
      open.set(event.data.commandId, wantedFromArgs(event.data.args))
    } else if (event.type === 'command/done') {
      const wanted = open.get(event.data.commandId)
      if (wanted === undefined) continue
      open.delete(event.data.commandId)
      if (event.data.kind === 'success') active = wanted
    }
  }
  return active
}

/** Mode state at the last logged request header, or undefined before the first header. */
function modeAtLastHeader(events) {
  let lastHeader = -1
  let index = 0
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index
    index += 1
  }
  if (lastHeader < 0) return undefined
  return foldUltracode(events, lastHeader + 1)
}

function resolveSection(config) {
  const section = config?.section
  if (section === undefined) return DEFAULT_SECTION
  if (typeof section !== 'string' || section.trim() === '') {
    throw new Error('dsh-ultracode: config.section must be a non-empty string when provided')
  }
  return section
}

export function apply(ctx, config = {}) {
  const section = resolveSection(config)

  const effective = (session) => foldUltracode(session.events)

  /**
   * Build a user-switch notice when the mode the model was last told (at the
   * last logged request header) differs from the current fold. Undefined
   * before the first header: the system prompt already reflects the mode.
   */
  const narration = (session) => {
    const target = foldUltracode(session.events)
    const told = modeAtLastHeader(session.events)
    if (told === undefined || told === target) return undefined
    const text = target
      ? 'The user switched this session into ultracode mode.'
      : 'The user switched this session out of ultracode mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ultracode', form: 'notice', summary: text },
    })
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const notice = narration(agent.session)
    if (notice === undefined) return decision
    return { ...decision, messages: [...decision.messages, notice] }
  })

  ctx.systemPrompt.section({
    name: 'ultracode:policy',
    order: 55,
    text: (context) => {
      if (context.agent === undefined) return ''
      return effective(context.agent.session) ? section : ''
    },
  })

  installEffortOverride(ctx, { isActive: effective })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND,
      description: 'Enter or leave ultracode mode (top reasoning effort + autonomous orchestration)',
      input: { hint: '[off|message]' },
      handler: ({ agent, rawInput }) => {
        // This invocation's own `command/run` is already logged but its
        // `command/done` is not, so the fold still reads the prior state;
        // the flip lands with the success `command/done` this return causes.
        const before = foldUltracode(agent.session.events)
        const message = rawInput.trim()
        if (message === 'off') {
          return {
            kind: 'success',
            text: before ? 'Ultracode mode off.' : 'Ultracode mode is already inactive.',
          }
        }
        if (message !== '') {
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: message }],
            source: { kind: 'user' },
          }))
        }
        return {
          kind: 'success',
          text: before
            ? 'Ultracode mode is already active.'
            : 'Ultracode mode on: top reasoning effort + autonomous orchestration. Use /ultracode off to leave.',
        }
      },
    })
  })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    if (z === undefined) {
      ctx.logger.warn('dsh-ultracode: zod not resolvable from the DSH host tree; skipping the ultracode projection')
      return
    }
    projectionCtx.sessionProjections.register({
      key: 'ultracode',
      schema: z.object({ active: z.boolean(), pending: z.boolean() }),
      init: () => ({ active: false, open: {} }),
      apply: (state, event) => {
        if (event.type === 'command/run') {
          if (event.data.name !== COMMAND || typeof event.data.args !== 'string') return state
          return {
            active: state.active,
            open: { ...state.open, [event.data.commandId]: wantedFromArgs(event.data.args) },
          }
        }
        if (event.type === 'command/done') {
          const wanted = state.open[event.data.commandId]
          if (wanted === undefined) return state
          const { [event.data.commandId]: _, ...open } = state.open
          return { active: event.data.kind === 'success' ? wanted : state.active, open }
        }
        return state
      },
      view: (state) => ({
        active: state.active,
        pending: Object.values(state.open).some((wanted) => wanted !== state.active),
      }),
      stateVersion: 2,
    })
  })
}
