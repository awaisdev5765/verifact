import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, fingerprint, mergeRules, defaultLedgerPath } from "../src/ledger/store.js";
import { verify, recordToLedger } from "../src/pipeline.js";
import { startDemoApp } from "../src/runner/demoapp.js";
import { Assertion, Rule } from "../src/rules/schema.js";

const PARAMS = { rate: 10, cap: 50, minCharge: 5 };
const REQ = { price: 100, quantity: 10, taxRate: 0.1 };

function rule(id: string, statement: string, assertions: Assertion[]): Rule {
  return { id, statement, phase: "business_rule", assertions, confidence: 1, source: { kind: "pr_body" } };
}

function quoteRule(id: string, statement: string, total: number): Rule {
  return rule(id, statement, [{
    kind: "api", method: "POST", path: "/quote", body: REQ,
    expectStatus: 200, expectField: "total", expectValue: total, comparator: "eq",
  }]);
}

function tmpLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "vf-ledger-")), "ledger.json");
}

test("fingerprint: restated intent dedupes, different intent does not", () => {
  const a = rule("R-1", "Discounts are capped at $50", []);
  const b = rule("R-2", "discounts  are  CAPPED AT $50!", []); // same meaning
  const c = rule("R-3", "Discounts are capped at $100", []);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test("ledger persists VERIFIED rules only, across instances", () => {
  const path = tmpLedger();
  const l1 = new Ledger(path);
  const res = l1.record("acme/api", [
    { rule: quoteRule("R-1", "total is (1000-50)*1.1", 1045), verdict: "VERIFIED" },
    { rule: quoteRule("R-2", "bogus rule", 1), verdict: "VIOLATED" },
    { rule: rule("R-3", "cannot test", []), verdict: "UNTESTABLE" },
  ]);
  assert.deepEqual(res, { added: 1, refreshed: 0 });

  const l2 = new Ledger(path); // fresh instance, same file
  const rules = l2.rulesFor("acme/api");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "R-1");
  assert.equal(l2.rulesFor("other/repo").length, 0); // repo-scoped
});

test("ledger record refreshes runs count instead of duplicating", () => {
  const path = tmpLedger();
  const l = new Ledger(path);
  const r = quoteRule("R-1", "total is (1000-50)*1.1", 1045);
  l.record("acme/api", [{ rule: r, verdict: "VERIFIED" }]);
  const { added, refreshed } = l.record("acme/api", [{ rule: r, verdict: "VERIFIED" }]);
  assert.deepEqual({ added, refreshed }, { added: 0, refreshed: 1 });
  assert.equal(new Ledger(path).stats("acme/api").total, 1);
});

test("merge: fresh wins collisions, ledger re-keyed LG-*, repo-scoped", () => {
  const fresh = [quoteRule("R-001", "discount capped at $50 then taxed", 1045)];
  const ledgerRules = [
    quoteRule("R-001", "shipping is free above $100", 999), // id collides, statement differs
    quoteRule("R-002", "discount capped at $50 then taxed", 1045), // same meaning as fresh
  ];
  const merged = mergeRules(fresh, ledgerRules);
  assert.equal(merged.length, 2);
  const lg = merged.find((r) => r.id.startsWith("LG-"))!;
  assert.ok(lg, "non-colliding ledger rule present with LG- id");
  assert.equal(lg.statement, "shipping is free above $100");
});

test("THE MOAT: ledger catches a reintroduced hallucination the new PR never mentions", async () => {
  const path = tmpLedger();
  const intent = "Discounts are capped at $50 before tax";

  // PR #1: correct implementation -> rules verified into the ledger
  const clean = startDemoApp(3801, PARAMS, {});
  const rep1 = await verify({
    repo: "acme/api", intentText: intent,
    rules: [quoteRule("R-001", "total is (1000-50)*1.1 = 1045 with cap applied", 1045)],
    target: ".", mode: "local", port: 3801, startCmd: "true", timeoutMs: 20000,
    ledger: path,
  });
  clean();
  assert.equal(rep1.summary.violated, 0);
  const recorded = recordToLedger(rep1, path);
  assert.equal(recorded.added, 1);

  // PR #2: a different change; its description says nothing about discounts.
  // The agent regressed the discount ordering (after-tax hallucination).
  const regressed = startDemoApp(3802, PARAMS, { applyAfterTax: true });
  try {
    const rep2 = await verify({
      repo: "acme/api", intentText: "Add pagination to the orders endpoint", // unrelated!
      rules: [], // no fresh rules — the ledger is the only defense
      target: ".", mode: "local", port: 3802, startCmd: "true", timeoutMs: 20000,
      ledger: path,
    });
    assert.equal(rep2.summary.violated, 1, "ledger regression net must fire");
    assert.match(rep2.results[0].rule.id, /^LG-/);
    assert.match(rep2.results[0].detail, /got/i);
  } finally {
    regressed();
  }
});

test("corrupt ledger file never crashes verification", async () => {
  const { writeFileSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "vf-ledger-")), "ledger.json");
  writeFileSync(path, "{not json at all");
  const l = new Ledger(path);
  assert.equal(l.stats().total, 0); // starts empty, no throw
});

test("prune removes stale entries, keeps fresh ones", () => {
  const path = tmpLedger();
  const l = new Ledger(path);
  const old = new Date(Date.now() - 100 * 86_400_000);
  const now = new Date();
  l.record("acme/api", [{ rule: quoteRule("R-1", "old rule", 1), verdict: "VERIFIED" }], old);
  l.record("acme/api", [{ rule: quoteRule("R-2", "fresh rule", 2), verdict: "VERIFIED" }], now);
  assert.equal(l.prune("acme/api", 90, now), 1);
  assert.deepEqual(new Ledger(path).rulesFor("acme/api").map((r) => r.id), ["R-2"]);
});

test("defaultLedgerPath respects env override", () => {
  const prev = process.env.VERIFACT_LEDGER_PATH;
  process.env.VERIFACT_LEDGER_PATH = "/tmp/vf-custom/ledger.json";
  try {
    assert.match(defaultLedgerPath(), /vf-custom/);
  } finally {
    if (prev === undefined) delete process.env.VERIFACT_LEDGER_PATH;
    else process.env.VERIFACT_LEDGER_PATH = prev;
  }
});
