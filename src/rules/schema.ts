/**
 * VeriFact rule schema.
 *
 * The rule ledger is the moat: every rule is a machine-checkable assertion of
 * INTENT, extracted from human language (PR body, ticket, agent chat), not from
 * the code. Rules are persisted per repo and become a regression net for every
 * future agent change.
 */

export type Verdict = "VERIFIED" | "VIOLATED" | "UNTESTABLE";

/** Structured assertion kinds the deterministic engine understands. */
export type Assertion =
  | {
      kind: "api";
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: unknown;
      /** expected HTTP status for the happy path */
      expectStatus?: number;
      /** JSON-path-ish selector into the response, e.g. "data.total" */
      expectField?: string;
      /** expected value or a comparator spec */
      expectValue?: string | number | boolean;
      /** comparator: eq (default) | gte | lte | neq */
      comparator?: "eq" | "gte" | "lte" | "neq";
    }
  | {
      kind: "invariant";
      /** natural-language invariant, evaluated by the engine where possible */
      statement: string;
    }
  | {
      kind: "error";
      /** fault to inject while asserting, e.g. "db_down", "timeout", "dup_submit" */
      inject: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      /** acceptable statuses under fault, e.g. [503] — anything 2xx here is a VIOLATION */
      acceptableStatuses: number[];
    };

export interface Rule {
  id: string;
  /** verbatim statement of intent from the human */
  statement: string;
  /** which phase of behavior this covers */
  phase: "happy_path" | "business_rule" | "error_handling" | "state";
  assertions: Assertion[];
  /** 0..1 confidence from the extractor; low-confidence rules surface as UNTESTABLE-eligible */
  confidence: number;
  /** provenance */
  source: { kind: "pr_body" | "ticket" | "chat" | "inferred"; ref?: string };
}

export interface RuleResult {
  rule: Rule;
  verdict: Verdict;
  /** human explanation, or repro on violation */
  detail: string;
  durationMs: number;
}

export interface VerificationReport {
  repo: string;
  pr?: { number: number; sha: string };
  results: RuleResult[];
  summary: { verified: number; violated: number; untestable: number; totalMs: number };
}

export function summarize(results: RuleResult[]): VerificationReport["summary"] {
  const verified = results.filter((r) => r.verdict === "VERIFIED").length;
  const violated = results.filter((r) => r.verdict === "VIOLATED").length;
  const untestable = results.filter((r) => r.verdict === "UNTESTABLE").length;
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
  return { verified, violated, untestable, totalMs };
}

export function makeId(prefix: string, i: number): string {
  return `${prefix}-${String(i).padStart(3, "0")}`;
}
