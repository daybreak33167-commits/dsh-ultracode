/**
 * dsh-ultracode — Claude Code "ultracode"-style session mode for DSH.
 *
 * While active, every model request is raised to the top reasoning effort the
 * selected model supports, and an orchestration policy section is included in
 * the system prompt so the agent fans substantive tasks out across parallel
 * subagents/workflows instead of grinding through one overloaded context.
 *
 * The state machine mirrors @deepseek-ai/dsh-plan-mode: mode flips are logged
 * per-session (`ultracode/mode`, last one wins) so resume and fork restore
 * them; a flip requested during an open turn stays pending until the next
 * accepted pre-step.
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

const MODE_EVENT = 'ultracode/mode'

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

/**
 * Whether ultracode is active after the first `end` events. The last
 * `ultracode/mode` wins; a prefix with none is inactive.
 */
export function foldUltracode(events, end = events.length) {
  let active = false
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index += 1
    if (event.type === MODE_EVENT) active = event.data.active
  }
  return active
}

/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events) {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
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
  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` marks user selections whose switch notice should ride the step.
   */
  const pendingIntents = new WeakMap()

  const effective = (session) => pendingIntents.get(session)?.active ?? foldUltracode(session.events)

  /** Build a user-switch notice when the last logged header described the other mode. */
  const narration = (session, target) => {
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

  /** Append one pending selection before the next request assembly. */
  const onBoundary = (session) => {
    const pending = pendingIntents.get(session)
    if (pending === undefined) return
    if (pending.active === foldUltracode(session.events)) {
      pendingIntents.delete(session)
      return
    }
    session.append(MODE_EVENT, { active: pending.active })
    pendingIntents.delete(session)
  }

  /**
   * Select whether ultracode should be active. Idle sessions commit the flip
   * immediately; during an open turn it stays pending until the next accepted
   * pre-step. Returns committed | queued | cancelled | noop (plan-mode's
   * contract).
   */
  const set = (agent, active) => {
    const session = agent.session
    if (active === effective(session)) return 'noop'
    if (hasOpenTurn(session.events)) {
      pendingIntents.set(session, { active, narrate: true })
      return foldUltracode(session.events) === active ? 'cancelled' : 'queued'
    }
    if (active === foldUltracode(session.events)) {
      pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append(MODE_EVENT, { active })
    pendingIntents.delete(session)
    const notice = narration(session, active)
    if (notice !== undefined) agent.inject(notice)
    return 'committed'
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const pending = pendingIntents.get(agent.session)
    if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
    const notice = narration(agent.session, pending.active)
    try {
      onBoundary(agent.session)
    } catch (error) {
      ctx.logger.warn('dsh-ultracode: failed to append selected mode at step start: %o', error)
      return decision
    }
    return !pending.narrate || notice === undefined
      ? decision
      : { ...decision, messages: [...decision.messages, notice] }
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
      name: 'ultracode',
      description: 'Enter or leave ultracode mode (top reasoning effort + autonomous orchestration)',
      input: { hint: '[off|message]' },
      handler: ({ agent, rawInput }) => {
        const message = rawInput.trim()
        if (message === 'off') {
          switch (set(agent, false)) {
            case 'committed':
              return { kind: 'success', text: 'Ultracode mode off.' }
            case 'queued':
              return { kind: 'success', text: 'Leaving ultracode mode (applies from the next step).' }
            case 'cancelled':
              return { kind: 'success', text: 'Ultracode mode entry cancelled.' }
            case 'noop':
              return foldUltracode(agent.session.events)
                ? { kind: 'success', text: 'Leaving ultracode mode (applies from the next step).' }
                : { kind: 'success', text: 'Ultracode mode is already inactive.' }
          }
        }
        const outcome = set(agent, true)
        if (message !== '') {
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: message }],
            source: { kind: 'user' },
          }))
        }
        switch (outcome) {
          case 'committed':
            return {
              kind: 'success',
              text: 'Ultracode mode on: top reasoning effort + autonomous orchestration. Use /ultracode off to leave.',
            }
          case 'cancelled':
            return { kind: 'success', text: 'Ultracode mode stays on (pending exit cancelled).' }
          case 'noop':
            return foldUltracode(agent.session.events)
              ? { kind: 'success', text: 'Ultracode mode is already active.' }
              : { kind: 'success', text: 'Entering ultracode mode (applies from the next step). Use /ultracode off to leave.' }
          default:
            return { kind: 'success', text: 'Entering ultracode mode (applies from the next step). Use /ultracode off to leave.' }
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
      init: () => ({ active: false, wanted: null }),
      apply: (state, event) => {
        if (event.type === 'command/run' && event.data.name === 'ultracode') {
          if (event.data.args === undefined) return state
          const wanted = event.data.args.trim() !== 'off'
          return wanted === state.wanted ? state : { active: state.active, wanted }
        }
        if (event.type === MODE_EVENT) return { active: event.data.active, wanted: null }
        return state
      },
      view: (state) => ({
        active: state.active,
        pending: state.wanted !== null && state.wanted !== state.active,
      }),
      stateVersion: 1,
    })
  })
}
