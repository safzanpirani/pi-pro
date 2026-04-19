# AGENTS.md

This repository contains the source for the `pi-pro` native Pi extension.

## Project intent

Build a quality-first Pro Mode for Pi with:

- strong read-only research flows
- safe code-edit flows
- explicit planning before mutation
- one-writer-only safety in code mode
- verifier-based post-write validation
- live status/cost visibility

## Core invariants

Do not violate these unless explicitly requested by the project owner:

1. `/pro` and `/pf` must remain strictly read-only
2. Only `/pro-code` and `/pcf` may mutate files
3. Only one final Action Agent may mutate files
4. Workers are read-only
5. Critics are read-only
6. Verifier is separate from Action Agent
7. No silent research -> code promotion
8. Code-mode writes must remain approval-gated

## Context policy

Treat context architecture as part of the safety model:

- `/pro`: full visible thread
- `/pf`: structured compaction + latest raw turns
- `/pro-code` planners/critics: full visible thread
- `/pro-code` action agent: focused execution brief
- `/pro-code` verifier: task + plan + actual diff/check context only
- `/pcf`: compacted planning context, focused action/verifier context

Do not casually collapse these into “just pass everything everywhere.”

## Planner output policy

The planner in code mode is expected to produce machine-readable structured JSON.
That is intentional.

Reason:
- approval needs a declared plan
- the action agent needs a focused execution brief
- the verifier needs a clear declared intent
- plan-vs-diff checking depends on declared touched files

Freeform prose plans are weaker and easier to misapply.

## Repository editing guidance

When working in this repo:

- prefer small, explicit changes
- keep prompts aligned with harness behavior
- do not loosen read-only roles by prompt only; prefer harness/tool-level enforcement
- keep README/PROGRESS updated when architecture changes
- do not add flashy autonomy at the expense of safety
- do not add extra top-level commands lightly

## What to update when behavior changes

If you change any of these, update docs too:

- default worker/critic counts
- context flow by command/role
- planner/action/verifier responsibilities
- safety guarantees
- command names/aliases
- benchmark behavior

## Near-term priorities

1. split final answer rendering from telemetry/report rendering
2. add checkpoint / undo-last before mutation
3. tighten structured-plan enforcement
4. improve verifier output / possible dual-verifier full mode
5. improve benchmarks and regression testing

## Publishing note

Do not commit secrets, local auth tokens, API keys, or user-specific shell configuration.
