/**
 * Intent extractor.
 *
 * Deterministic core: a rule pattern parser over human language. LLM is only
 * allowed to PROPOSE extra rules; the deterministic parser output is always
 * kept, and the runner EXECUTES everything — this is what kills the
 * rubber-stamp problem: no assertion exists unless it can be run.
 */
import { Assertion, Rule, makeId } from "../rules/schema.js";

/** Heuristic extraction of business rules from natural language. */
export function extractHeuristic(text: string): Rule[] {
  const rules: Rule[] = [];
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const clean = line.replace(/^[-*>\d.\s]+/, "").trim();
    if (!clean) continue;

    // api-shaped rule: "POST /orders must return 201"
    const api = clean.match(
      /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s+(?:must|should|has to|needs to)\s+(?:return|respond with|give)\s+(?:status\s+)?(\d{3})/i,
    );
    if (api) {
      rules.push({
        id: "",
        statement: clean,
        phase: "happy_path",
        confidence: 0.9,
        source: { kind: "pr_body" },
        assertions: [{
          kind: "api",
          method: api[1].toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
          path: api[2],
          expectStatus: Number(api[3]),
        }],
      });
      continue;
    }

    // numeric cap / floor rules: "... capped at $50", "... at least 5"
    const cap = clean.match(/capped?\s+(?:at|to)\s+\$?([\d.]+)/i);
    const floor = clean.match(/at\s+least\s+\$?([\d.]+)/i);
    if (cap || floor) {
      const value = Number(cap ? cap[1] : floor![1]);
      rules.push({
        id: "",
        statement: clean,
        phase: "business_rule",
        confidence: 0.8,
        source: { kind: "pr_body" },
        assertions: [{
          kind: "invariant",
          statement: cap
            ? `result must never exceed ${value}`
            : `result must never be below ${value}`,
        }],
      });
      continue;
    }

    // ordering rules: "apply X before Y"
    if (/\b(before|after)\b/i.test(clean) && /\b(apply|calculate|compute|charge|tax|discount)\b/i.test(clean)) {
      rules.push({
        id: "",
        statement: clean,
        phase: "business_rule",
        confidence: 0.75,
        source: { kind: "pr_body" },
        assertions: [{ kind: "invariant", statement: clean }],
      });
      continue;
    }

    // fault tolerance rules: "when X fails / is down / times out ... must ..."
    const fault = clean.match(
      /(?:when|if)\s+(?:the\s+)?(?:db|database|payment|upstream|external|network)[\w\s]*(?:fails?|is down|down|times? out|unavailable)/i,
    );
    if (fault) {
      rules.push({
        id: "",
        statement: clean,
        phase: "error_handling",
        confidence: 0.85,
        source: { kind: "pr_body" },
        assertions: [{
          kind: "error",
          inject: "db_down",
          method: "GET",
          path: "/health",
          acceptableStatuses: [503],
        }],
      });
      continue;
    }
  }

  return rules.map((r, i) => ({ ...r, id: makeId("R", i + 1) }));
}

export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}

/** Optional LLM-assisted extraction (OpenAI-compatible endpoint). Returns [] without a key. */
export async function extractWithLlm(text: string, llm?: LlmClient): Promise<Rule[]> {
  if (!llm) return [];
  const system =
    "Extract machine-checkable business rules from the text. " +
    'Reply with ONLY a JSON array: [{"statement":"...","phase":"business_rule","assertions":[{"kind":"invariant","statement":"..."}]}]. ' +
    "Only include rules testable against a running HTTP API.";
  try {
    const raw = await llm.complete(system, text);
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end <= start) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed.map((p: Partial<Rule>, i: number) => ({
      id: makeId("L", i + 1),
      statement: String(p.statement ?? ""),
      phase: p.phase ?? "business_rule",
      assertions: (p.assertions ?? []) as Assertion[],
      confidence: 0.6,
      source: { kind: "pr_body" },
    }));
  } catch {
    return []; // LLM failure must never reduce verification coverage
  }
}

export async function extractIntent(text: string, llm?: LlmClient): Promise<Rule[]> {
  const deterministic = extractHeuristic(text);
  const proposed = await extractWithLlm(text, llm);
  // dedupe by normalized statement; deterministic rules always win
  const seen = new Set(deterministic.map((r) => norm(r.statement)));
  const merged = [...deterministic];
  for (const p of proposed) {
    if (!seen.has(norm(p.statement))) merged.push(p);
  }
  return merged;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
