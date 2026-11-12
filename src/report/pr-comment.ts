/**
 * PR report: verdict table as a PR comment, posted via the GitHub REST API.
 * Every VIOLATED row links to a repro — trust comes from evidence, not tone.
 */
import { VerificationReport } from "../rules/schema.js";

export function renderComment(report: VerificationReport): string {
  const s = report.summary;
  const icon = (v: string) =>
    v === "VERIFIED" ? "✅" : v === "VIOLATED" ? "❌" : "⚪";

  const rows = report.results
    .map(
      (r) =>
        `| ${icon(r.verdict)} ${r.rule.id} | ${escape(r.rule.statement)} | ${r.verdict} | ${escape(r.detail)} |`,
    )
    .join("\n");

  const headline =
    s.violated > 0
      ? `## ⚠️ VeriFact: ${s.violated} intent violation${s.violated > 1 ? "s" : ""} found`
      : `## ✅ VeriFact: all ${s.verified} verifiable rules passed`;

  return `${headline}

Verified this change against the stated intent by **executing** it, not by reading the diff.

| Rule | Intent (verbatim) | Verdict | Detail |
|---|---|---|---|
${rows}

_${s.verified} verified · ${s.violated} violated · ${s.untestable} untestable · ${(s.totalMs / 1000).toFixed(1)}s_

<sub>VeriFact — runtime behavioral verification. Untestable means no API mapping was found; it never silently passes.</sub>`;
}

function escape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export async function postComment(report: VerificationReport, opts: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "verifact",
      },
      body: JSON.stringify({ body: renderComment(report) }),
    },
  );
  if (!res.ok) throw new Error(`GitHub comment failed: ${res.status} ${await res.text()}`);
}
