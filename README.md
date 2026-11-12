# VeriFact

**Runtime behavioral verification for AI-generated code.**

VeriFact verifies that code does what the human *meant* — by **executing it**, not by reading the diff. Diff-readers (CodeRabbit, Qodo) rubber-stamp hallucinated business logic; VeriFact extracts machine-checkable rules from the intent (PR description, ticket, later: agent chat) and runs them against the real app in a sandbox.

## Why

- 96% of developers don't fully trust AI-generated code; only 48% verify before commit (Sonar, 2026)
- AI code has 1.7× more errors; review time up 93% (LinearB)
- The failure mode nobody owns: **hallucinated logic** — compiles, diff looks clean, tests stay green, the discount math is wrong

## Architecture

```
intent (PR body / ticket / chat)
  └─> intent extractor ── deterministic rule parser (+ optional LLM proposals)
        └─> rule ledger (compounding regression net per repo)
              └─> test generator ── rules -> executable black-box probes
                    └─> sandbox runner ── app under test isolated (docker / local)
                          ├─> property-based probes that BIND the constraint
                          └─> failure injection at the wire (db_down, timeout, ...)
                                └─> verdicts: VERIFIED / VIOLATED / UNTESTABLE
                                      └─> PR comment with per-rule repro
```

Design invariants:
- **LLM proposes, the runner executes.** No assertion exists unless it can be run. LLM failure never reduces coverage.
- **UNTESTABLE is an honest verdict.** It never silently passes.
- **Every VIOLATED verdict carries a repro.** Trust comes from evidence.
- **The ledger only remembers proven intent.** VERIFIED rules are persisted per repo (fingerprinted by normalized statement + phase); VIOLATED/UNTESTABLE never are. Fresh PR intent wins collisions; ledger rules are re-keyed `LG-*` so ids can't collide. Entries older than the max age (default 90d) are pruned.

### The moat, demonstrated

A test in `tests/ledger.test.ts` proves the full flywheel:

1. PR #1 states "discounts capped at $50 before tax" — implementation is correct → rule verified → **recorded in the ledger**
2. PR #2 changes something unrelated ("add pagination"); its description says nothing about discounts — but the agent regressed the discount ordering (after-tax hallucination)
3. The ledger rule re-runs automatically and **catches the regression** — no human remembered to test for it

```bash
npm run benchmark   # 100 seeded cases
# Detection rate (bugs caught):        100.0%
# False-positive rate (clean flagged):   0.0%
```

The key technique: property-based probing. A single input usually can't distinguish a correct cap implementation from a dropped one (if the discount never reaches the cap). VeriFact generates extra probes chosen to **bind the constraint** — huge quantity to blow past the cap, tiny price to fall under the minimum charge.

## Benchmark (this repo, reproducible)

100 seeded cases across 4 rule families (discount ordering, cap enforcement, minimum charge, dependency failure), 80% containing an injected hallucinated-logic bug, 20% clean as a false-positive control:

```bash
npm run benchmark

Detection rate (bugs caught):        100.0%
False-positive rate (clean flagged):   0.0%
```

## Usage

```bash
npm run build

# CLI: verify a repo against an intent file
node dist/src/cli/index.js run ./my-repo --intent intent.md --start "npm start"

# GitHub App webhook server
VERIFACT_WEBHOOK_SECRET=... GITHUB_TOKEN=... npm run server

# MCP server (Cursor / Claude Code)
npm run mcp
```

Example intent file:

```md
POST /quote must return 200
Apply a 10% discount before tax, capped at $50
When the database is down, respond with 503
```

## Components

| Path | Role |
|---|---|
| `src/rules/schema.ts` | Rule + verdict schema (the ledger contract) |
| `src/intent/extract.ts` | Deterministic rule parser + optional LLM assist |
| `src/testgen/generate.ts` | Rules → executable black-box test script |
| `src/runner/sandbox.ts` | Docker/local sandbox orchestration |
| `src/runner/injections.ts` | Wire-level failure-injection proxy |
| `src/pipeline.ts` | intent → rules → run → report |
| `src/report/pr-comment.ts` | Verdict table PR comment |
| `src/gh/webhook.ts` | GitHub App entry point |
| `src/mcp/server.ts` | MCP stdio server (`verify_change` tool) |
| `src/cli/index.ts` | `verifact run` / `dogfood` / `ledger` CLI with CI exit codes |
| `src/report/dashboard.ts` | Verification-debt dashboard (server-rendered, zero deps) |
| `src/ledger/store.ts` | Rule ledger: persistence, fingerprints, merge policy, pruning |
| `src/intent/llm.ts` | OpenAI/Anthropic/custom LLM adapters for intent extraction |
| `benchmark/harness.ts` | The 100-case scoring harness |

## Deployment (hosted service)

See **[DEPLOY.md](DEPLOY.md)**. One `fly deploy` ships the whole product:
webhook + sandbox verification + ledger + dashboard.

- `GET /healthz` — probe endpoint
- `GET /` — verification-debt dashboard (repos, rules, runs, staleness)
- `POST /webhook` — HMAC-verified GitHub events

## Real-world dogfood finding (Nov 2026)

Extraction-only dogfood runs against live OSS PRs (expressjs/express, vitest-dev/vitest,
5 open PRs each) produced **0 extractable rules — deterministically and honestly reported**.
This is the single most important product insight so far:

> Real-world PR descriptions are *change summaries* ("fix: preserve raw bytes of
> ArrayBuffer views"), not specs. Testable intent lives in linked issues, agent
> chat, and spec docs — not PR bodies.

Implications, now baked into the plan:
1. **The LLM extraction path is not optional** — it's the primary path; the
   deterministic parser is a floor, not the product.
2. **Intent capture must follow the sources of truth**: linked-issue enrichment
   is implemented in dogfood (`Closes #N` resolution); Cursor/Claude Code chat
   capture is the critical v1 feature.
3. **The honest zero-report is a feature**: a PR with no testable intent is
   reported as such, never rubber-stamped.

## Roadmap (v1+)

- Python/Go repos; intent capture from Cursor/Claude Code chat (partner integration)
- SQLite/Postgres ledger backend (interface is ready)
- Self-hosted runner for enterprise (secrets never leave the VPC)
- Detection-rate reporting per repo ("verification debt" metric)
- Benchmark growth: 1,000 cases across stacks, published as a public report

## Pricing (planned)

Free (public repos, 50 runs/mo) · Team $49/dev/mo · Enterprise self-host $30–60k/yr

## Status

MVP + ledger + hosted-service ready: extractor (+LLM adapters), generator, runner, injection proxy, PR reporter, dashboard, webhook, MCP server, CLI (`run`/`dogfood`/`ledger`), rule ledger with regression-net flywheel, Dockerfile + Fly/Render configs — 35/35 tests, benchmark gate passed at 100% / 0%.
