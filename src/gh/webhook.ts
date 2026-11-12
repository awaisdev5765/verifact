/**
 * GitHub App webhook entry point.
 * pull_request (opened/synchronize) -> run pipeline -> post verdict comment.
 */
import http from "node:http";
import crypto from "node:crypto";
import { verify, recordToLedger } from "../pipeline.js";
import { postComment, renderComment } from "../report/pr-comment.js";
import { renderDashboard } from "../report/dashboard.js";
import { llmFromEnv } from "../intent/llm.js";
import { Ledger, defaultLedgerPath } from "../ledger/store.js";

const PORT = Number(process.env.VERIFACT_PORT ?? 8080);
const SECRET = process.env.VERIFACT_WEBHOOK_SECRET ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const APP_URL = process.env.VERIFACT_APP_URL ?? "http://127.0.0.1:3000";

function signedOk(raw: string, signature: string | undefined): boolean {
  if (!SECRET) return true; // dev mode
  if (!signature?.startsWith("sha256=")) return false;
  const mac = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  const given = signature.slice(7);
  // timingSafeEqual throws on length mismatch — a malformed signature must
  // 401, not crash the service. Length check first (lengths aren't secret).
  if (given.length !== mac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(given));
}

http
  .createServer(async (req, res) => {
    const url = req.url ?? "/";

    // Health check for load balancers / Fly / Railway / Render probes.
    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, llm: !!llmFromEnv(), ledger: defaultLedgerPath() }));
      return;
    }

    // Verification-debt dashboard.
    if (req.method === "GET" && (url === "/" || url === "/dashboard")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderDashboard(new Ledger(defaultLedgerPath())));
      return;
    }

    if (req.method !== "POST" || url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();

    if (!signedOk(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
      res.writeHead(401).end();
      return;
    }

    const event = JSON.parse(raw);
    res.writeHead(202).end(); // ack fast; work happens async

    if (req.headers["x-github-event"] !== "pull_request") return;
    const action = event.action;
    if (action !== "opened" && action !== "synchronize") return;

    const pr = event.pull_request;
    const repoFullName = event.repository.full_name as string;
    const [owner, repo] = repoFullName.split("/");
    const prNumber = pr.number as number;

    try {
      const report = await verify({
        repo: repoFullName,
        pr: { number: prNumber, sha: pr.head.sha },
        intentText: `${pr.title ?? ""}\n\n${pr.body ?? ""}`,
        target: process.env.VERIFACT_TARGET ?? ".",
        startCmd: process.env.VERIFACT_START_CMD,
        llm: llmFromEnv(),
      });
      if (TOKEN) await postComment(report, { token: TOKEN, owner, repo, prNumber });
      else console.log(renderComment(report));
      // Proven intent -> ledger regression net (server-side flywheel).
      recordToLedger(report);
    } catch (e) {
      console.error("verification failed:", e);
    }
  })
  .listen(PORT, () => console.log(`verifact webhook on :${PORT} (app url ${APP_URL})`));
