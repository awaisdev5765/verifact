/**
 * verifact CLI
 *
 *   verifact run <repoDir> --intent <file.md> [--start "npm start"] [--port 3000]
 *
 * Runs intent extraction + sandbox verification locally, prints the verdict table.
 */
import { readFileSync } from "node:fs";
import { verify } from "../pipeline.js";
import { llmFromEnv } from "../intent/llm.js";
import { dogfoodMain } from "./dogfood.js";

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "ledger") {
    const { Ledger, defaultLedgerPath } = await import("../ledger/store.js");
    const ledger = new Ledger(defaultLedgerPath());
    const repo = process.argv[3];
    if (arg("--prune")) {
      const removed = ledger.prune(repo!, Number(arg("--max-age", "90")));
      console.log(`pruned ${removed} stale entr${removed === 1 ? "y" : "ies"} from ${repo}`);
    }
    const s = ledger.stats(repo);
    console.log(`ledger: ${s.total} rule(s)${repo ? ` for ${repo}` : ""} across ${s.repos} repo(s), ${s.runs} total runs`);
    for (const r of ledger.rulesFor(repo ?? "")) {
      console.log(`  [${r.phase}] ${r.statement}`);
    }
    return;
  }
  if (cmd === "dogfood") {
    await dogfoodMain();
    return;
  }
  if (cmd !== "run") {
    console.error(`verifact — runtime behavioral verification for AI-generated code

USAGE
  verifact run <repoDir> --intent <intent.md> [--start "npm start"] [--port 3000] [--timeout 120000]
  verifact dogfood <owner/repo> [--pr N] [--state open] [--limit 10] [--port N] [--start CMD]
  verifact ledger [owner/repo] [--prune] [--max-age 90]

ENV
  GITHUB_TOKEN              GitHub API access (dogfood)
  VERIFACT_LLM_PROVIDER     openai | anthropic | openai_compat (default openai)
  VERIFACT_LLM_API_KEY      LLM key — enables intent extraction from messy PR text
  VERIFACT_LLM_MODEL        model id (provider default if unset)
  VERIFACT_LLM_BASE_URL     override endpoint (openai_compat)

MODES
  docker  (default when docker is available)   local   (fallback)`);
    process.exit(cmd === "run" ? 0 : 1);
  }

  const repoDir = process.argv[3];
  const intentFile = arg("--intent");
  if (!repoDir || !intentFile) {
    console.error("error: need <repoDir> and --intent <file>");
    process.exit(1);
  }

  const intentText = readFileSync(intentFile, "utf8");
  const report = await verify({
    repo: repoDir,
    intentText,
    target: repoDir,
    startCmd: arg("--start", "npm start"),
    port: Number(arg("--port", "3000")),
    timeoutMs: Number(arg("--timeout", "120000")),
    mode: (arg("--mode") as "docker" | "local" | undefined) ?? undefined,
    llm: llmFromEnv(),
  });

  const { verified, violated, untestable } = report.summary;
  if (verified > 0) {
    const { recordToLedger } = await import("../pipeline.js");
    const rec = recordToLedger(report); // proven intent -> regression net
    if (rec.added) console.log(`ledger: +${rec.added} rule(s) recorded`);
  }
  for (const r of report.results) {
    const mark = r.verdict === "VERIFIED" ? "✅" : r.verdict === "VIOLATED" ? "❌" : "⚪";
    console.log(`${mark} ${r.rule.id.padEnd(6)} ${r.verdict.padEnd(10)} ${r.rule.statement}`);
    if (r.verdict !== "VERIFIED") console.log(`           ↳ ${r.detail}`);
  }
  console.log(`\n${verified} verified · ${violated} violated · ${untestable} untestable`);
  process.exit(violated > 0 ? 2 : 0); // CI-friendly gate
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
