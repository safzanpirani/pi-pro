# pi-pro

A native Pi extension that adds quality-first multi-agent orchestration on top of Fireworks Kimi K2.5 Turbo.

`pi-pro` gives Pi four simple commands:

- `/pro` — best-quality read-only research mode
- `/pf` / `/profast` — faster read-only research mode
- `/pc` / `/pro-code` — safe code mode with one writer
- `/pcf` / `/procodefast` — faster safe code mode

## Goals

- Maximize answer quality with best-of-N orchestration
- Keep research modes strictly read-only
- Keep code mode safe via plan -> confirm -> one writer -> verifier
- Surface live cost, run count, and stage progress
- Preserve useful conversation context without blindly handing the same raw context to every stage

## Current architecture

### Research modes

#### `/pro`
Full-thread, quality-first research flow:

1. Full visible session context goes to workers
2. Read-only workers run in parallel
3. Read-only critics review/rank outputs
4. One read-only integrator produces the final answer

#### `/pf`
Fast research flow with structured context compaction:

1. The visible thread is compacted into structured briefs
2. Workers receive:
   - latest raw user request
   - latest raw conversation turns
   - durable constraints
   - compacted context brief
3. Read-only workers run in parallel
4. One read-only integrator produces the final answer

### Code modes

#### `/pro-code`
Safe coding flow:

1. A constraints compactor extracts durable constraints
2. Read-only planning workers inspect the task/codebase
3. Read-only critics review the plans
4. A planner produces a structured plan JSON object
5. User confirms the plan
6. One final Action Agent edits the real workspace
7. One separate Verifier checks the actual diff/workspace

#### `/procodefast`
Lighter safe coding flow:

1. Context compaction runs first
2. Read-only planning workers inspect from compacted context
3. A planner produces a structured plan JSON object
4. User confirms the plan
5. One final Action Agent edits the real workspace
6. One separate Verifier checks the actual diff/workspace

## Safety invariants

These are non-negotiable:

- `/pro` and `/pf` are read-only
- workers are read-only in all modes
- critics are read-only in all modes
- only one final Action Agent may mutate files
- the Verifier is separate from the Action Agent
- no silent promotion from research mode into code mode
- code mode requires explicit approval before mutation

## Context policy

`pi-pro` uses role-specific context instead of a single raw transcript policy:

- `/pro`: full visible thread for workers, critics, integrator
- `/pf`: compacted brief + latest raw turns + durable constraints
- `/pro-code` planners/critics: full visible thread
- `/pro-code` action agent: focused execution brief only
- `/pro-code` verifier: task + approved plan + actual diff/check context only
- `/procodefast` planners: compacted brief + latest raw turns
- `/procodefast` action/verifier: focused briefs only

## Why the planner returns JSON

In code mode, the planner is intentionally pushed to return structured JSON rather than freeform prose.

That is not because JSON is prettier — it is because the harness needs something machine-readable for safety:

- display the plan clearly before approval
- identify declared files to touch
- compare the declared plan against the actual diff
- hand a focused execution brief to the Action Agent
- hand a focused verification brief to the Verifier

Without a structured plan, the confirmation step is mostly “approve this blob of prose,” which is weaker.

## Current defaults

- `/pro`: 8 workers + 3 critics + 1 integrator
- `/pf`: 2 context compactor runs + 4 workers + 1 integrator
- `/pro-code`: 1 constraints compactor + 6 workers + 3 critics + 1 planner + 1 action + 1 verifier
- `/pcf`: 2 context compactors + 3 workers + 1 planner + 1 action + 1 verifier

These are quality-first defaults tuned for a Fireworks Fire Pass / low-cost-pressure setup.

## Installation

This repo contains the extension source. To use it inside Pi, place or symlink it into your Pi extensions directory.

Typical local setup:

```bash
ln -s /path/to/pi-pro ~/.pi/agent/extensions/pro-mode
```

Then reload Pi.

## Files

- `index.ts` — orchestration runtime, commands, UI/reporting
- `prompts.ts` — system prompts and context compactor prompt
- `benchmarks.ts` — built-in benchmark cases
- `AGENTS.md` — contributor/agent guidelines for this repo
- `PROGRESS.md` — running log of architecture and follow-up work

## Current known follow-ups

- split final answer vs telemetry/report into separate output channels
- add checkpoint / undo-last before mutation
- harden plan enforcement further when planner output is invalid
- possibly add multiple verifier support in full code mode
- improve benchmark coverage and regression tracking

## Status

This is an active working repo for the Pro Mode extension, not a polished package release yet.
