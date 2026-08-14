# dsh-ultracode

Claude Code `ultracode`-style session mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

When ultracode is on for a session, DSH:

1. **Forces top reasoning effort** — every model request is upgraded to the
   highest effort the selected model supports (for example `effort=xhigh` on
   Cursor GPT models, `max` on DeepSeek), while preserving the rest of the
   current selection (Max context / Fast stay as chosen).
2. **Injects an orchestration policy** — a system-prompt section that has the
   agent decompose substantive tasks and fan them out across parallel
   background `subagent` runs (or a single `workflow` for large pipelines),
   keeping its own context for coordination and verification. Small tasks are
   still done directly.

The mode is session-scoped and logged: it survives resume/fork, and it resets
naturally because new sessions start with it off — mirroring Claude Code's
deliberately non-persistent `/effort ultracode`.

## Usage

```
/ultracode              turn on for this session
/ultracode <message>    turn on and immediately send <message>
/ultracode off          turn off
```

Switches during an open turn apply from the next step, exactly like `/plan`.

## Install

```powershell
dsh plugin --profile web add C:\Users\Administrator\dsh-ultracode
```

## Config

Optional plugin config (via a `cordis.patch.yml` layer):

```yaml
- id: ultracode
  config:
    section: |
      # Ultracode mode
      ...your own orchestration guidance...
```

`section` replaces the built-in orchestration policy text.

## How it works

- State is a custom session-log event `ultracode/mode` (last one wins),
  folded on read — the same state machine as `@deepseek-ai/dsh-plan-mode`,
  including pending switches committed at the next accepted pre-step.
- The prompt section registers as `ultracode:policy` (order 55) through
  `ctx.systemPrompt.section` and renders only while the mode is active.
- The effort override is an `agent/request` waterfall listener (prepended, so
  it post-processes after the Web UI's model selection). It resolves the
  model's advertised effort ladder via `ctx.llm.resolveModelInfo` and picks
  the highest rung, so unsupported values are never sent.
- A `ultracode` session projection (`{ active, pending }`) is exposed for
  UIs; the bundled web client renders an "Ultra" chip next to the composer
  that turns the mode off on click.
