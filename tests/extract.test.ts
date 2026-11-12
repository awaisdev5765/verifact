import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHeuristic, extractIntent } from "../src/intent/extract.js";
import { generateTestScript } from "../src/testgen/generate.js";
import { computeQuote } from "../src/runner/demoapp.js";

test("extractor finds API-shaped rules", () => {
  const rules = extractHeuristic(
    "POST /orders must return 201\nGET /health must return status 200",
  );
  assert.equal(rules.length, 2);
  assert.equal(rules[0].assertions[0].kind, "api");
  assert.equal((rules[0].assertions[0] as any).expectStatus, 201);
  assert.equal((rules[0].assertions[0] as any).path, "/orders");
});

test("extractor finds cap and fault rules", () => {
  const rules = extractHeuristic(
    "discount capped at $50\n- when the database is down, respond with 503",
  );
  assert.equal(rules.length, 2);
  assert.equal(rules[0].phase, "business_rule");
  assert.equal(rules[1].phase, "error_handling");
  assert.equal((rules[1].assertions[0] as any).inject, "db_down");
});

test("LLM failure never reduces coverage", async () => {
  const rules = await extractIntent("POST /x must return 200", {
    complete: async () => { throw new Error("api down"); },
  });
  assert.equal(rules.length, 1); // deterministic rules survive
});

test("generated test script executes against a live app", async () => {
  const rules = extractHeuristic("POST /quote must return 200");
  const { startDemoApp } = await import("../src/runner/demoapp.js");
  const { runInSandbox } = await import("../src/runner/sandbox.js");
  const stop = startDemoApp(3777, { rate: 10, cap: 50, minCharge: 5 }, {});
  try {
    const results = await runInSandbox(rules, { target: ".", mode: "local", port: 3777, startCmd: "true", timeoutMs: 15000 });
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, "VERIFIED");
  } finally {
    stop();
  }
});

test("reference implementation catches the after-tax hallucination", () => {
  const req = { price: 100, quantity: 10, taxRate: 0.1 }; // cap binds here
  const params = { rate: 10, cap: 50, minCharge: 5 };
  const correct = computeQuote(req, params);
  const hallucinated = computeQuote(req, params, { applyAfterTax: true });
  assert.notEqual(correct.total, hallucinated.total);
});
