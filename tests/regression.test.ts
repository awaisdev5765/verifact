import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHeuristic, extractIntent } from "../src/intent/extract.js";
import { generateTestScript } from "../src/testgen/generate.js";
import { startDemoApp } from "../src/runner/demoapp.js";
import { runInSandbox } from "../src/runner/sandbox.js";
import { verify } from "../src/pipeline.js";
import { renderComment } from "../src/report/pr-comment.js";
import { Assertion, Rule, RuleResult, VerificationReport, summarize } from "../src/rules/schema.js";

const PARAMS = { rate: 10, cap: 50, minCharge: 5 };

function rule(id: string, assertions: Assertion[], statement = "(test)"): Rule {
  return { id, statement, phase: "business_rule", assertions, confidence: 1, source: { kind: "pr_body" } };
}

test("REGRESSION: injected fault does not leak into later assertions", async () => {
  // db_down makes the app return 503. If the fault leaked after the error
  // assertion, the following api assertion would see 503 and false-positive.
  const stop = startDemoApp(3790, PARAMS, {});
  try {
    const rules = [
      rule("E-001", [{ kind: "error", inject: "db_down", method: "POST", path: "/quote", acceptableStatuses: [503] }]),
      rule("A-001", [{ kind: "api", method: "POST", path: "/quote", body: { price: 100, quantity: 2, taxRate: 0.1 }, expectStatus: 200 }]),
    ];
    const results = await runInSandbox(rules, { target: ".", mode: "local", port: 3790, startCmd: "true", timeoutMs: 20000 });
    const byId = new Map(results.map((r) => [r.rule.id, r.verdict]));
    assert.equal(byId.get("E-001"), "VERIFIED");
    assert.equal(byId.get("A-001"), "VERIFIED", "fault leaked into later assertion");
  } finally {
    stop();
  }
});

test("E2E: clean implementation verifies; hallucinated implementation is caught", async () => {
  const rules = (bugs: object) => [
    rule("B-01", [{
      kind: "api",
      method: "POST",
      path: "/quote",
      body: { price: 100, quantity: 10, taxRate: 0.1 },
      expectStatus: 200,
      expectField: "total",
      expectValue: 1045, // correct: (1000-50)*1.1
      comparator: "eq",
    }]),
  ];
  const clean = startDemoApp(3791, PARAMS, {});
  try {
    const rep = await verify({
      repo: "demo", intentText: "10% discount before tax capped at $50", rules: rules({}),
      target: ".", mode: "local", port: 3791, startCmd: "true", timeoutMs: 20000,
    });
    assert.equal(rep.summary.violated, 0);
    assert.equal(rep.summary.verified, 1);
  } finally {
    clean();
  }
  const buggy = startDemoApp(3792, PARAMS, { applyAfterTax: true });
  try {
    const rep = await verify({
      repo: "demo", intentText: "10% discount before tax capped at $50", rules: rules({}),
      target: ".", mode: "local", port: 3792, startCmd: "true", timeoutMs: 20000,
    });
    assert.equal(rep.summary.violated, 1, "hallucinated after-tax logic must be VIOLATED");
    assert.match(rep.results[0].detail, /got/); // repro-style detail
  } finally {
    buggy();
  }
});

test("UNTESTABLE is honest: dead port is reported, never silently passed", async () => {
  const stop = startDemoApp(3793, PARAMS, {});
  stop(); // shut it down: port 3793 is now dead
  await assert.rejects(
    runInSandbox(
      [rule("X-001", [{ kind: "api", method: "POST", path: "/quote", body: { price: 1, quantity: 1, taxRate: 0 }, expectStatus: 200 }])],
      { target: ".", mode: "local", port: 3793, startCmd: "true", timeoutMs: 20000 },
    ),
    /did not become ready/,
  );
});

test("hung app cannot hang the run: per-request timeout applies", async () => {
  const http = await import("node:http");
  const hang = http.createServer(() => { /* accepts TCP, never responds */ });
  hang.listen(3794);
  try {
    const results = await runInSandbox(
      [rule("H-001", [{ kind: "api", method: "GET", path: "/", expectStatus: 200 }])],
      { target: ".", mode: "local", port: 3794, startCmd: "true", timeoutMs: 20000 },
    );
    assert.equal(results[0].verdict, "VIOLATED");
    assert.match(results[0].detail, /abort|timeout/i);
  } finally {
    hang.close();
  }
});

test("report rendering: table, counts, escaping", () => {
  const ruleA = rule("R-001", [], "POST /quote must return 200 | with pipes");
  const report: VerificationReport = {
    repo: "demo",
    results: [
      { rule: ruleA, verdict: "VIOLATED", detail: "expected status 200, got 500", durationMs: 12 },
      { rule: rule("R-002", []), verdict: "VERIFIED", detail: "status 200", durationMs: 5 },
      { rule: rule("R-003", []), verdict: "UNTESTABLE", detail: "no API mapping", durationMs: 0 },
    ],
    summary: { verified: 1, violated: 1, untestable: 1, totalMs: 17 },
  };
  const md = renderComment(report);
  assert.match(md, /⚠️ VeriFact: 1 intent violation/);
  assert.match(md, /\\| with pipes/); // pipe escaped so table stays intact
  assert.match(md, /1 verified · 1 violated · 1 untestable/);
  assert.equal(summarize(report.results).violated, 1);
});

test("extractor: dedupes LLM proposals against deterministic rules", async () => {
  const rules = await extractIntent("POST /x must return 200", {
    complete: async () => JSON.stringify([
      { statement: "POST /x must return 200", phase: "business_rule", assertions: [] },
      { statement: "GET /x must never exceed 5 items", phase: "business_rule", assertions: [{ kind: "invariant", statement: "x" }] },
    ]),
  });
  assert.equal(rules.length, 2); // duplicate dropped, new one kept
  assert.equal(rules[0].id.startsWith("R-"), true); // deterministic wins the id space
});

test("extractor: empty input yields no rules, no crash", () => {
  assert.deepEqual(extractHeuristic(""), []);
  assert.deepEqual(extractHeuristic("   \n \n"), []);
});

test("extractor: malformed LLM output is discarded safely", async () => {
  const rules = await extractIntent("POST /x must return 200", {
    complete: async () => "no json here at all",
  });
  assert.equal(rules.length, 1); // deterministic still present
});
