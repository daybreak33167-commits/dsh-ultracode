// Ad-hoc smoke test: run with `node smoke.test.mjs`. Not shipped (see package.json files).
import assert from 'node:assert/strict'
import { pickTopEffort, decodeEffortId } from './effort.js'
import { foldUltracode } from './index.js'

const gpt = {
  efforts: [
    'effort=low', 'effort=low|max=true',
    'effort=medium', 'effort=medium|max=true',
    'effort=high', 'effort=high|max=true',
    'effort=xhigh', 'effort=xhigh|max=true',
  ].map((id) => ({ id, name: id })),
  defaultEffort: 'effort=medium',
}
assert.equal(pickTopEffort(gpt, undefined), 'effort=xhigh', 'gpt default -> xhigh (no max)')
assert.equal(pickTopEffort(gpt, 'effort=low|max=true'), 'effort=xhigh|max=true', 'gpt keeps max=true')
assert.equal(pickTopEffort(gpt, 'effort=xhigh'), undefined, 'already top -> no override')
assert.equal(pickTopEffort(gpt, 'effort=xhigh|max=true'), undefined, 'top with max -> no override')

const deepseek = {
  efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
  defaultEffort: 'high',
}
assert.equal(pickTopEffort(deepseek, undefined), 'max', 'deepseek default -> max')
assert.equal(pickTopEffort(deepseek, 'max'), undefined, 'deepseek already max')

const claude = {
  efforts: [
    'effort=low', 'effort=low|max=true',
    'effort=medium', 'effort=medium|max=true',
    'effort=high', 'effort=high|max=true',
  ].map((id) => ({ id, name: id })),
  defaultEffort: 'effort=medium',
}
assert.equal(pickTopEffort(claude, undefined), 'effort=high', 'claude -> high (no max)')

const auto = {
  efforts: ['optimize_for=cost', 'optimize_for=balanced', 'optimize_for=intelligence'].map((id) => ({ id, name: id })),
  defaultEffort: 'optimize_for=balanced',
}
assert.equal(pickTopEffort(auto, undefined), 'optimize_for=intelligence', 'auto -> intelligence')

const kimi = {
  efforts: [{ id: 'max=false', name: 'Default' }, { id: 'max=true', name: 'Max' }],
  defaultEffort: 'max=false',
}
assert.equal(pickTopEffort(kimi, undefined), undefined, 'no effort knob -> no override')

const composer = {
  efforts: [{ id: 'fast=false', name: 'Standard' }, { id: 'fast=true', name: 'Fast' }],
  defaultEffort: 'fast=true',
}
assert.equal(pickTopEffort(composer, undefined), undefined, 'fast-only -> no override')

assert.equal(pickTopEffort(undefined, undefined), undefined, 'no reasoning metadata')
assert.equal(pickTopEffort({ efforts: [] }, undefined), undefined, 'empty ladder')

assert.deepEqual(decodeEffortId('effort=XHigh|max=true'), [
  { id: 'effort', value: 'xhigh' },
  { id: 'max', value: 'true' },
])

const run = (commandId, args) => ({ type: 'command/run', data: { commandId, name: 'ultracode', args, source: { kind: 'user' } } })
const done = (commandId, kind) => ({ type: 'command/done', data: { commandId, kind } })

const events = [
  { type: 'session/start', data: {} },
  run('cmd-1', ''),
  done('cmd-1', 'success'),
  { type: 'turn/start', data: {} },
  run('cmd-2', ' off'),
  done('cmd-2', 'success'),
]
assert.equal(foldUltracode(events), false, 'last successful command wins')
assert.equal(foldUltracode(events, 4), true, 'prefix fold sees only the first pair')
assert.equal(foldUltracode(events, 5), true, 'unsettled run leaves the fold alone')
assert.equal(foldUltracode([]), false, 'empty log inactive')

assert.equal(
  foldUltracode([run('cmd-3', ''), done('cmd-3', 'error')]),
  false,
  'errored command changes nothing',
)
assert.equal(
  foldUltracode([
    { type: 'command/run', data: { commandId: 'cmd-4', name: 'ultracode', source: { kind: 'user' } } },
    done('cmd-4', 'success'),
  ]),
  false,
  'run with unrecorded args states no intent',
)
assert.equal(
  foldUltracode([
    { type: 'command/run', data: { commandId: 'cmd-5', name: 'compact', args: '', source: { kind: 'user' } } },
    done('cmd-5', 'success'),
  ]),
  false,
  'other commands are ignored',
)
assert.equal(
  foldUltracode([run('cmd-6', ' focus on the API layer'), done('cmd-6', 'success')]),
  true,
  'message argument still turns the mode on',
)

console.log('smoke: all assertions passed')
