import assert from "node:assert/strict";
import { test } from "node:test";
import { VerificationReport, summarize } from "../src/rules/schema.js";
import { renderComment, postComment } from "../src/report/pr-comment.js";

test("dogfood-style PR intent extraction: messy real-world PR body", async () => {
  const { extractHeuristic } = await import("../src/intent/extract.js");
  // A realistic PR description
  const body = `## What
Adds discount support to checkout.

- POST /checkout must return 201
- Discounts are capped at $50
- If the payment provider times out we must return 502
- Apply loyalty points after tax

Closes #142`;
  const rules = extractHeuristic(body);
  const statements = rules.map((r) => r.statement);
  assert.ok(statements.some((s) => /checkout must return 201/.test(s)), "API rule found");
  assert.ok(statements.some((s) => /capped at \$50/.test(s)), "cap rule found");
  assert.ok(statements.some((s) => /payment provider times out/.test(s)), "fault rule found");
  // "after tax" ordering rule detected
  assert.ok(statements.some((s) => /after tax/i.test(s)), "ordering rule found");
});

test("postComment: hits the right endpoint and body shape", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
  }) as typeof fetch;
  try {
    const report: VerificationReport = {
      repo: "acme/api",
      pr: { number: 7, sha: "abc" },
      results: [],
      summary: { verified: 0, violated: 0, untestable: 0, totalMs: 0 },
    };
    await postComment(report, { token: "t0k", owner: "acme", repo: "api", prNumber: 7 });
    assert.equal(captured!.url, "https://api.github.com/repos/acme/api/issues/7/comments");
    assert.equal((captured!.init.headers as any).authorization, "Bearer t0k");
    const body = JSON.parse(captured!.init.body as string);
    assert.match(body.body, /VeriFact/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("postComment: API failure surfaces as error, not silent success", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => "forbidden" })) as unknown as typeof fetch;
  try {
    const report: VerificationReport = {
      repo: "acme/api",
      results: [],
      summary: summarize([]),
    };
    await assert.rejects(
      postComment(report, { token: "t0k", owner: "acme", repo: "api", prNumber: 7 }),
      /403/,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("rule shape sanity: every rule has id, statement, source", async () => {
  const { extractHeuristic } = await import("../src/intent/extract.js");
  for (const r of extractHeuristic("POST /a must return 200\nwhen the database is down return 503\ncapped at $10")) {
    assert.ok(r.id && r.statement && r.source && r.confidence > 0);
    assert.ok(r.assertions.length > 0);
  }
});
