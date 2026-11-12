/**
 * Dogfood runner: point VeriFact at a real GitHub repo's pull requests.
 *
 *   verifact dogfood owner/repo --pr 42            # one PR
 *   verifact dogfood owner/repo --state open --limit 10
 *
 * For each PR it fetches title/body (intent), builds rules, and reports what
 * it CAN and CANNOT verify. Verification against the live app requires the
 * app running locally (--port + --start); without it, output is an honest
 * extraction-only report — exactly what you review before wiring CI.
 */
import { extractIntent } from "../intent/extract.js";
import { llmFromEnv } from "../intent/llm.js";
import { verify } from "../pipeline.js";

interface PrInfo {
  number: number;
  title: string;
  body: string;
  headSha: string;
}

async function fetchIssueBody(repo: string, issueNumber: number, token?: string): Promise<string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "verifact" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, { headers });
  if (!res.ok) return "";
  const issue = (await res.json()) as any;
  return `${issue.title ?? ""}\n${issue.body ?? ""}`.trim();
}

/** Resolve "Closes #N" / "Fixes #N" references — linked issues usually carry the real intent. */
export function linkedIssues(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|addresses?)\s+#(\d+)/gi)) {
    nums.add(Number(m[1]));
  }
  return [...nums];
}

export async function enrichIntent(pr: PrInfo, repo: string, token?: string): Promise<string> {
  const parts = [`${pr.title}\n\n${pr.body}`.trim()];
  for (const n of linkedIssues(`${pr.title}\n${pr.body}`)) {
    const body = await fetchIssueBody(repo, n, token);
    if (body) parts.push(`[linked issue #${n}]\n${body}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

async function fetchPrs(repo: string, prNumber?: number, state = "open", limit = 10, token?: string): Promise<PrInfo[]> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "verifact",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  if (prNumber) {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const p = (await res.json()) as any;
    return [{ number: p.number, title: p.title ?? "", body: p.body ?? "", headSha: p.head?.sha ?? "" }];
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=${state}&per_page=${limit}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as any[]).map((p) => ({
    number: p.number,
    title: p.title ?? "",
    body: p.body ?? "",
    headSha: p.head?.sha ?? "",
  }));
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export async function dogfoodMain(): Promise<void> {
  const repo = process.argv[3];
  if (!repo || !repo.includes("/")) {
    console.error('usage: verifact dogfood owner/repo [--pr 42] [--state open] [--limit 10] [--port 3000] [--start "npm start"]');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN;
  const prs = await fetchPrs(repo, arg("--pr") ? Number(arg("--pr")) : undefined, arg("--state") ?? "open", Number(arg("--limit") ?? 10), token);
  const llm = llmFromEnv();
  const port = arg("--port") ? Number(arg("--port")) : undefined;
  const startCmd = arg("--start");

  console.log(`verifact dogfood: ${repo} — ${prs.length} PR(s), LLM ${llm ? "enabled" : "OFF (deterministic only)"}\n`);

  for (const pr of prs) {
    const intentText = await enrichIntent(pr, repo, token);
    console.log(`── PR #${pr.number}: ${pr.title}`);
    if (!intentText || intentText.length < 5) {
      console.log("   (no usable intent text — skipping)\n");
      continue;
    }

    if (!port || !startCmd) {
      // extraction-only mode: show the rules we would verify
      const rules = await extractIntent(intentText, llm);
      if (rules.length === 0) {
        console.log("   0 rules extractable — PR description lacks testable intent statements\n");
        continue;
      }
      for (const r of rules) {
        console.log(`   ${r.id} [${r.phase}] (conf ${r.confidence.toFixed(2)}) ${r.statement}`);
      }
      console.log();
      continue;
    }

    try {
      const report = await verify({
        repo,
        pr: { number: pr.number, sha: pr.headSha },
        intentText,
        target: process.env.VERIFACT_TARGET ?? ".",
        startCmd,
        port,
        llm,
      });
      const s = report.summary;
      console.log(`   ${s.verified} verified · ${s.violated} violated · ${s.untestable} untestable`);
      for (const r of report.results) {
        if (r.verdict !== "VERIFIED") console.log(`   ❌ ${r.rule.id}: ${r.rule.statement}\n      ↳ ${r.detail}`);
      }
    } catch (e) {
      console.log(`   verification failed: ${e instanceof Error ? e.message : e}`);
    }
    console.log();
  }
}
