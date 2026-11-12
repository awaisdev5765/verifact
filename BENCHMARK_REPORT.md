# VeriFact Benchmark Report

_Generated 2026-11-10T11:11:43.901Z — reproducible via `npm run benchmark`_

## Method

100 seeded cases across 4 rule families of an instrumented pricing API.
80% contain an **injected hallucinated-logic bug** (the class of defect AI
coding agents produce and diff-based review misses); 20% are clean, serving
as a false-positive control. Each case's expected behavior comes from an
independent reference implementation, never from the shipped code.

## Results

| Metric | Result |
|---|---|
| Detection rate (bugs caught) | **100.0%** |
| False-positive rate (clean flagged) | **0.0%** |

| Family | Bugs | Detected | False positives |
|---|---|---|---|
| discount_before_tax | 20 | 20/20 (100%) | 0/5 |
| discount_cap | 20 | 20/20 (100%) | 0/5 |
| minimum_charge | 20 | 20/20 (100%) | 0/5 |
| dependency_failure | 20 | 20/20 (100%) | 0/5 |

## Key technique

Property-based probing: a single input rarely distinguishes a correct
constraint implementation from a dropped one (if the discount never reaches
the cap, a missing cap is invisible). VeriFact generates extra probes chosen
to **bind the constraint** — quantities that blow past the cap, prices that
fall under the minimum charge — so the violation is observable on at least
one probe.

## What this does and does not claim

- It measures VeriFact's verification engine on executable business rules
  against a live HTTP API.
- It does not measure natural-language extraction coverage (see the dogfood
  finding: real-world PR descriptions are change summaries, not specs — the
  LLM extraction path and agent-chat capture are required for production).
