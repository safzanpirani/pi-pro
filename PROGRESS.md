# PROGRESS

## Current state

The Pro Mode extension exists and runs inside Pi with Fireworks Kimi K2.5 Turbo.

### Implemented

- `/pro`, `/p`
- `/profast`, `/pf`
- `/pro-code`, `/pc`
- `/procodefast`, `/pcf`
- `/pro-bench`
- live run dashboard with progress/cost info
- full-thread research context for `/pro`
- structured context compaction for fast modes
- split-context code-mode handoffs
- structured planner output for code mode
- single Action Agent writer model
- separate Verifier role
- diff-aware verifier handoff

### Architecture now in place

#### Research
- `/pro`: full thread -> workers -> critics -> integrator
- `/pf`: compactor -> workers -> integrator

#### Code
- `/pro-code`: constraints compactor -> planners -> critics -> structured plan -> confirm -> one writer -> verifier
- `/pcf`: compactor -> planners -> structured plan -> confirm -> one writer -> verifier

## Open follow-ups

### High priority
- fix final output rendering by splitting answer vs telemetry channels
- add checkpoint / rollback before code-mode mutation
- harden planner JSON enforcement further

### Medium priority
- improve plan-vs-diff divergence surfacing
- consider dual-verifier support in full code mode
- improve compactor robustness and omission reporting
- add worker/run inspection command(s)

### Benchmarks
- expand benchmark coverage
- compare topology changes over time
- track regressions in quality / safety / latency

## Notes

The planner currently outputs structured JSON in code mode on purpose. That supports machine-readable approval, execution, and verification handoff.
