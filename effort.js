/**
 * Top-effort override for ultracode mode.
 *
 * DSH reasoning-effort ids are provider-specific opaque strings: DeepSeek uses
 * bare levels (`off` | `high` | `max`), the Cursor adapter encodes parameter
 * packs (`effort=xhigh|max=true`, `optimize_for=intelligence`, ...). The
 * override therefore never hardcodes a level: it reads the exact model's
 * advertised effort ladder from `ctx.llm.resolveModelInfo` and picks the
 * highest rung, so `prepareCall` (which rejects unsupported efforts without
 * clamping) never sees an invalid value.
 */

const EFFORT_KEYS = new Set(['effort', 'reasoning', 'reasoning_effort', 'thinking'])
const OPTIMIZE_KEYS = new Set(['optimize_for', 'optimization'])

const EFFORT_RANK = {
  ultrahigh: 6,
  xhigh: 5,
  max: 4,
  high: 3,
  medium: 2,
  low: 1,
  minimal: 1,
  off: 0,
  none: 0,
}

const OPTIMIZE_RANK = {
  intelligence: 3,
  balanced: 2,
  balance: 2,
  cost: 1,
}

/** Decode `a=b|c=d` parameter packs; a bare token counts as an effort level. */
export function decodeEffortId(effortId) {
  if (effortId === undefined || effortId === null || String(effortId) === '') return []
  return String(effortId).split('|').filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    if (index <= 0) return { id: 'effort', value: part.toLowerCase() }
    return { id: part.slice(0, index).toLowerCase(), value: part.slice(index + 1).toLowerCase() }
  })
}

/** Effort strength of one decoded choice, or undefined when it has no effort-ish knob. */
function effortScore(params) {
  let score
  for (const param of params) {
    if (EFFORT_KEYS.has(param.id)) {
      score = Math.max(score ?? -1, EFFORT_RANK[param.value] ?? 0)
    } else if (OPTIMIZE_KEYS.has(param.id)) {
      score = Math.max(score ?? -1, OPTIMIZE_RANK[param.value] ?? 0)
    }
  }
  return score
}

function isActiveValue(value) {
  return value !== '' && value !== 'false' && value !== '0' && value !== 'off' && value !== 'default'
}

function nonEffortParams(params) {
  const map = new Map()
  for (const param of params) {
    if (EFFORT_KEYS.has(param.id) || OPTIMIZE_KEYS.has(param.id)) continue
    map.set(param.id, param.value)
  }
  return map
}

/**
 * How well a candidate preserves the current selection's non-effort knobs
 * (Max context, Fast, ...). Only the effort should climb; everything else
 * should stay where the user put it.
 */
function similarity(candidateParams, currentParams) {
  const candidate = nonEffortParams(candidateParams)
  const current = nonEffortParams(currentParams)
  let score = 0
  for (const key of new Set([...candidate.keys(), ...current.keys()])) {
    const a = candidate.get(key)
    const b = current.get(key)
    if (a === b) {
      score += 1
      continue
    }
    const aActive = a !== undefined && isActiveValue(a)
    const bActive = b !== undefined && isActiveValue(b)
    // Absent and inactive (`max=false` vs no `max`) are equivalent selections.
    if (aActive !== bActive) score -= 1
  }
  return score
}

/**
 * Pick the strongest effort the model advertises, preserving non-effort
 * parameters of the current selection. Returns undefined when there is
 * nothing to raise (no ladder, no effort knob, or already at the top).
 *
 * @param reasoning `LlmResolvedModelInfo.reasoning` (`{ efforts, defaultEffort }`).
 * @param currentEffortId the effort currently on the call config, if any.
 */
export function pickTopEffort(reasoning, currentEffortId) {
  const efforts = reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const current = decodeEffortId(currentEffortId ?? reasoning.defaultEffort)
  let best
  for (const choice of efforts) {
    if (choice?.id === undefined) continue
    const params = decodeEffortId(choice.id)
    const score = effortScore(params)
    if (score === undefined) continue
    const sim = similarity(params, current)
    if (best === undefined || score > best.score || (score === best.score && sim > best.sim)) {
      best = { id: choice.id, score, sim }
    }
  }
  if (best === undefined) return undefined
  const currentScore = effortScore(current)
  if (currentScore !== undefined && currentScore >= best.score) return undefined
  return best.id
}

/**
 * Register the `agent/request` waterfall listener that raises the effort while
 * ultracode is active.
 *
 * Prepended so it stays outermost: its post-`next()` upgrade then runs after
 * the Web UI's model-selection listener (`installModelSelection`, registered
 * per agent) has applied the user's provider/model/effort choice — the
 * override composes on top instead of being overwritten.
 */
export function installEffortOverride(ctx, { isActive }) {
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const agent = payload?.agent
    if (agent === undefined || !isActive(agent.session)) return config
    if (!config?.provider || !config?.model) return config
    let info
    try {
      info = await ctx.llm.resolveModelInfo(config.provider, config.model, payload.signal)
    } catch (error) {
      ctx.logger.debug?.('dsh-ultracode: resolveModelInfo failed, leaving effort untouched: %o', error)
      return config
    }
    const target = pickTopEffort(info?.reasoning, config.reasoningEffort)
    if (target === undefined || target === config.reasoningEffort) return config
    return { ...config, reasoningEffort: target }
  }, { prepend: true })
}
