import assert from "node:assert/strict";
import { test } from "node:test";
import { extractIntent } from "../src/intent/extract.js";
import { openAiClient, anthropicClient } from "../src/intent/llm.js";

/** Mock global fetch; restore after each test. */
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>): void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => handler(String(url), init)) as typeof fetch;
  queueMicrotask(() => {}); // keep async semantics
  (globalThis as any).__restoreFetch = () => (globalThis.fetch = orig);
}

test("openai adapter: sends model + messages, returns content", async () => {
  let captured: any;
  mockFetch(async (url, init) => {
    captured = { url, body: JSON.parse(init!.body as string), headers: init!.headers as Record<string, string> };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content: "hello" } }] }) };
  });
  try {
    const client = openAiClient("sk-test", "gpt-4o-mini", "https://api.example.com");
    const out = await client.complete("sys", "usr");
    assert.equal(out, "hello");
    assert.match(captured.url, /\/v1\/chat\/completions$/);
    assert.equal(captured.body.model, "gpt-4o-mini");
    assert.equal(captured.body.temperature, 0);
    assert.equal(captured.body.messages[0].role, "system");
    assert.equal(captured.headers.authorization, "Bearer sk-test");
  } finally {
    (globalThis as any).__restoreFetch();
  }
});

test("anthropic adapter: x-api-key + anthropic-version, system as top-level", async () => {
  let captured: any;
  mockFetch(async (url, init) => {
    captured = { url, body: JSON.parse(init!.body as string), headers: init!.headers as Record<string, string> };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ content: [{ text: "part1" }, { text: "part2" }] }) };
  });
  try {
    const client = anthropicClient("ak-test", "claude-sonnet-4-5", "https://api.anthropic.com");
    const out = await client.complete("sys", "usr");
    assert.equal(out, "part1part2");
    assert.match(captured.url, /\/v1\/messages$/);
    assert.equal(captured.body.system, "sys");
    assert.ok(!captured.body.messages.some((m: any) => m.role === "system"));
    assert.equal(captured.headers["x-api-key"], "ak-test");
  } finally {
    (globalThis as any).__restoreFetch();
  }
});

test("LLM API error -> proposals discarded, deterministic rules survive", async () => {
  mockFetch(async () => ({ ok: false, status: 429, text: async () => "rate limited", json: async () => ({}) }));
  try {
    const rules = await extractIntent(
      "POST /quote must return 200",
      openAiClient("sk-test", "gpt-4o-mini", "https://api.example.com"),
    );
    assert.equal(rules.length, 1); // deterministic rule intact
    assert.equal(rules[0].id.startsWith("R-"), true);
  } finally {
    (globalThis as any).__restoreFetch();
  }
});

test("LLM proposals add coverage the deterministic parser misses", async () => {
  // messy PR text the regex parser can't fully structure, LLM structures it
  mockFetch(async () => ({
    ok: true, status: 200, text: async () => "",
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify([
            { statement: "concurrent duplicate submissions must produce a single charge", phase: "state", assertions: [{ kind: "invariant", statement: "single charge under duplication" }] },
          ]),
        },
      }],
    }),
  }));
  try {
    const rules = await extractIntent(
      "POST /pay must return 200. Double-clicking must not charge twice.",
      openAiClient("sk-test", "gpt-4o-mini", "https://api.example.com"),
    );
    assert.equal(rules.length, 2); // deterministic R-001 + LLM L-001
    assert.ok(rules.some((r) => r.id.startsWith("L-")));
  } finally {
    (globalThis as any).__restoreFetch();
  }
});
