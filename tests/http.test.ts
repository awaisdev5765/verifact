import assert from "node:assert/strict";
import { test, after } from "node:test";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3900;
const SECRET = "test-secret";
const ledgerFile = join(mkdtempSync(join(tmpdir(), "vf-http-")), "ledger.json");

const server = spawn(process.execPath, ["dist/src/gh/webhook.js"], {
  env: {
    ...process.env,
    VERIFACT_PORT: String(PORT),
    VERIFACT_WEBHOOK_SECRET: SECRET,
    VERIFACT_LEDGER_PATH: ledgerFile,
    GITHUB_TOKEN: "", // no token -> dashboard-only mode
  },
  stdio: "ignore",
});
after(() => {
  server.kill();
});

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("webhook server did not start");
}

test("server boots; /healthz reports llm + ledger status", async () => {
  await waitForServer();
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; llm: boolean; ledger: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.llm, "boolean");
  assert.match(body.ledger, /ledger\.json$/);
});

test("dashboard renders valid HTML with expected sections", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/dashboard`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /VeriFact/);
  assert.match(html, /verified rules/);
  assert.match(html, /No repos yet|Repositories/);
});

test("dashboard escapes HTML in rule statements (XSS safety)", async () => {
  // Seed the ledger with a hostile statement via the public API shape.
  const { Ledger } = await import("../src/ledger/store.js");
  const l = new Ledger(ledgerFile);
  l.record("evil/repo", [{
    rule: {
      id: "X-1",
      statement: '<script>alert("xss")</script>',
      phase: "business_rule",
      assertions: [],
      confidence: 1,
      source: { kind: "pr_body" },
    },
    verdict: "VERIFIED",
  }]);
  const html = await fetch(`http://127.0.0.1:${PORT}/dashboard`).then((r) => r.text());
  assert.ok(!html.includes("<script>alert"), "unescaped script tag reached the page");
  assert.ok(html.includes("&lt;script&gt;"), "statement was escaped");
  l.clear();
});

test("webhook rejects bad HMAC signature with 401", async () => {
  const body = JSON.stringify({ action: "opened", pull_request: { number: 1 }, repository: { full_name: "a/b" } });
  const res = await fetch(`http://127.0.0.1:${PORT}/webhook`, {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request", "content-type": "application/json" },
    body,
  });
  assert.equal(res.status, 401);
});

test("webhook accepts valid HMAC signature with 202", async () => {
  const body = JSON.stringify({ action: "opened", pull_request: { number: 1, title: "x", body: "POST /q must return 200" }, repository: { full_name: "a/b" } });
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const res = await fetch(`http://127.0.0.1:${PORT}/webhook`, {
    method: "POST",
    headers: {
      "x-hub-signature-256": `sha256=${mac}`,
      "x-github-event": "pull_request",
      "content-type": "application/json",
    },
    body,
  });
  assert.equal(res.status, 202); // ack-fast; async pipeline runs without crashing
});

test("unknown routes 404", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
  assert.equal(res.status, 404);
});
