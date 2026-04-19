# Pro Mode Extension

Native Pi ensemble orchestration for high-quality answers and safer multi-run coding workflows.

## Commands

### Research
- `/pro <task>` — full read-only mode, defaults to **8 workers + 3 critics + 1 integrator**
- `/profast <task>` — lighter read-only mode, defaults to **2 context compactor runs + 4 workers + 1 integrator**
- `/p <task>` — shortcut for `/pro`
- `/pf <task>` — shortcut for `/profast`

### Coding
- `/pro-code <task>` — safe coding mode, defaults to **1 constraints compactor + 6 planning workers + 3 critics + 1 planner + 1 action agent + 1 verifier**
- `/procodefast <task>` — lighter safe coding mode, defaults to **2 context compactor runs + 3 planning workers + 1 planner + 1 action agent + 1 verifier**
- `/pc <task>` — shortcut for `/pro-code`
- `/pcf <task>` — shortcut for `/procodefast`

### Benchmarks
- `/pro-bench [case-id|all]` — run built-in benchmark fixtures

## Model

All Pro commands target:
- `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo`

via the Fireworks provider remap in:
- `~/.pi/agent/extensions/fireworks-provider-remap.ts`

## Orchestration modes

### `single`
One solver only.

Flow:
1. One integrator/solver run
2. Return final answer

Use when you want a baseline or lowest latency.

### `fanout`
Fast-mode topology with context compaction first.

Research flow:
1. One or more context compactor runs condense the current session into structured briefs
2. N read-only workers run in parallel from the compacted brief + latest raw turns
3. One final integrator produces one answer

Code flow:
1. One or more context compactor runs build structured briefs for planners
2. N read-only planning workers run in parallel
3. One planner synthesizes a structured implementation plan
4. After approval, one action agent writes and one verifier checks

Default for `/profast` and `/procodefast`.

### `critique`
Multiple workers, explicit critics, then one final synthesis or plan.

Research flow:
1. N read-only workers run in parallel
2. M read-only critics review/rank worker outputs
3. One final integrator synthesizes worker + critic output

Code flow:
1. One constraints compactor extracts durable constraints
2. N read-only planning workers run in parallel
3. M read-only critics review/rank worker outputs
4. One planner synthesizes a structured implementation plan
5. After approval, one action agent writes and one verifier checks

Default for `/pro` and `/pro-code`.

## Context inheritance

Pro Mode now uses **role-specific context policies** instead of one raw transcript policy for every stage.

- `/pro`: full visible branch transcript goes to workers, critics, and integrator
- `/profast`: the visible transcript is compacted first into structured working notes, then workers see:
  - latest raw user request
  - latest raw conversation turns
  - durable constraints
  - one compacted context brief
- `/pro-code` planners/critics: full visible branch transcript
- `/pro-code` action agent: focused execution brief only
- `/pro-code` verifier: original task + approved plan + actual diff/check context only
- `/procodefast` planners: compacted brief + latest raw turns
- `/procodefast` action/verifier: same focused briefs as `/pro-code`

Included in raw context capture:
- user messages
- assistant messages
- tool result messages
- custom session messages

Omitted:
- hidden reasoning/thinking blocks

## Code mode safety

Code mode can edit files, but only through a **single final action agent**.

Safety rules:
- `/pro` and `/profast` are strictly read-only research commands
- `/pro-code` and `/procodefast` are the only code-mode commands
- workers and critics are always read-only
- only one final action agent can edit the real workspace
- every code-mode run asks for confirmation before the write stage
- the planner returns a structured plan JSON object
- the verifier receives the actual workspace diff, not just action-agent prose

The confirmation includes:
- task summary
- total planned runs
- model
- context availability summary
- a preview of the structured plan/files to touch

### Workspace behavior in code mode

#### Direct/shared workspace (default)
The real workspace is only touched by the final action agent.

Flow:
1. Read-only planners inspect the workspace
2. A structured plan is produced and approved
3. One final action agent edits the real workspace
4. One verifier checks the real workspace afterward

#### Isolated planning workers (optional)
If explicitly requested with `--isolated`, planning workers can inspect copied temporary workspaces.

This is optional and off by default.

## Live UI

During a Pro run, the widget/status line shows:
- run mode and total planned runs
- progress bar with done/total counts
- live total cost across all completed/active runs
- active model
- available session-context message count
- per-run recent activity
- per-run cost for the latest active/completed runs

Examples:
- `Pro [Full] 8+3+1 = 12 runs [█████░░░░░░░░░░░] 5/12`
- `ProFast [2+4+1] 7 runs [██████████░░░░░░░░] 6/7`
- `💰 Total: $0.0787`
- `🧠 Session context available: 42 messages`

## Cost accounting

Each child run tracks usage returned by Pi/model metadata.

Tracked per run:
- input tokens
- output tokens
- cache read tokens
- cache write tokens
- total cost
- turn count

Aggregated live:
- total cost across all runs in the active orchestration

Persisted in final report:
- `totalCost`
- `expectedRuns`
- `contextMessageCount`
- per-run usage summaries

## Final report rendering

The final report includes:
- strategy and mode
- total duration
- model
- expected run count
- worker / critic counts
- whether isolated workspaces were used
- full chat context message count
- total cost
- each run’s preview and usage stats
- the final synthesized answer

## Benchmarks

Built-in benchmark file:
- `~/.pi/agent/extensions/pro-mode/benchmarks.ts`

Current fixtures:
- `ranges`
- `slugify`
- `manifest`

They are Python-based and now use:
- `python3 -m unittest -q`

## Examples

### High-quality research answer
```text
/pro Design the safest architecture for a best-of-N coding orchestrator in Pi
```

### Faster research answer
```text
/profast Compare SQLite vs Postgres for a local-first desktop app
```

### Full coding mode
```text
/pro-code Fix a bug in the current project and validate the result
```

### Faster coding mode
```text
/procodefast Add a small docs improvement and verify it
```

### Explicit flags
```text
/pro --fanout --workers 6 Explain the tradeoffs of verifier-free inference-time scaling
/pro-code --critique --workers 8 --critics 2 Refactor the provider loading flow
/pro-code --single --direct Make one small surgical fix
```

## Notes

- Cost is calculated from actual child run usage metadata.
- Research commands are intended to be read/search oriented.
- Code commands should be used only when you explicitly want file mutation.
- If you want maximum safety, keep code mode isolated and confirm before running.
