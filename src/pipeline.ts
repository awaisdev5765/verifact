/**
 * Pipeline: intent -> rules -> generated tests -> sandbox run -> report.
 */
import { Rule, RuleResult, VerificationReport, summarize } from "./rules/schema.js";
import { extractIntent, LlmClient } from "./intent/extract.js";
import { runInSandbox, SandboxOptions } from "./runner/sandbox.js";
import { Ledger, mergeRules, defaultLedgerPath } from "./ledger/store.js";

export interface PipelineOptions extends SandboxOptions {
  intentText: string;
  /** Supply rules directly (skips extraction) — used by CI and the benchmark. */
  rules?: Rule[];
  llm?: LlmClient;
  repo: string;
  pr?: { number: number; sha: string };
  /** Enable the rule ledger (default: on, path from VERIFACT_LEDGER_PATH). */
  ledger?: boolean | string;
}

export async function verify(opts: PipelineOptions): Promise<VerificationReport> {
  const fresh = opts.rules ?? (await extractIntent(opts.intentText, opts.llm));

  // Regression net: fresh intent rules take precedence; ledger fills the gaps.
  let ledger: Ledger | undefined;
  let ledgerRules: Rule[] = [];
  const ledgerOpt = opts.ledger;
  if (ledgerOpt !== false && !(ledgerOpt === undefined && process.env.VERIFACT_NO_LEDGER)) {
    ledger = new Ledger(typeof ledgerOpt === "string" ? ledgerOpt : defaultLedgerPath());
    ledgerRules = ledger.rulesFor(opts.repo);
  }
  const rules = mergeRules(fresh, ledgerRules);

  const raw: RuleResult[] = await runInSandbox(rules, opts);

  // Join runner output back to rules by id, keep honest UNTESTABLE verdicts.
  const byId = new Map(raw.map((r) => [r.rule.id, r]));
  const results: RuleResult[] = rules.map((rule) => {
    const hits = raw.filter((r) => r.rule.id === rule.id);
    if (hits.length === 0) {
      return {
        rule,
        verdict: "UNTESTABLE" as const,
        detail: "no executable assertion was generated for this rule",
        durationMs: 0,
      };
    }
    const worst = hits.find((h) => h.verdict === "VIOLATED") ?? hits[0];
    return { rule, verdict: worst.verdict, detail: worst.detail, durationMs: worst.durationMs };
  });

  return {
    repo: opts.repo,
    pr: opts.pr,
    results,
    summary: summarize(results),
  };
}

/** Persist newly-verified intent into the ledger (call after reviewing a report). */
export function recordToLedger(
  report: VerificationReport,
  ledgerPath?: string,
): { added: number; refreshed: number } {
  const ledger = new Ledger(ledgerPath ?? defaultLedgerPath());
  return ledger.record(report.repo, report.results.map((r) => ({ rule: r.rule, verdict: r.verdict })));
}

export type { Rule };
