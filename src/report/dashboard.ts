/**
 * Dashboard: the "verification debt" view.
 *
 * Zero-dependency server-rendered HTML from the ledger. This is the page
 * leadership sees: which repos have proven intent captured, how often the
 * regression net has fired, and where coverage is thin.
 */
import { Ledger } from "../ledger/store.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function days(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function renderDashboard(ledger: Ledger): string {
  const entries = ledger
    .entries()
    .sort((a, b) => a.repo.localeCompare(b.repo) || b.lastVerifiedAt.localeCompare(a.lastVerifiedAt));

  const repos = new Map<string, { rules: number; runs: number; stale: number }>();
  for (const e of entries) {
    const r = repos.get(e.repo) ?? { rules: 0, runs: 0, stale: 0 };
    r.rules += 1;
    r.runs += e.runs;
    if (days(e.lastVerifiedAt) > 30) r.stale += 1;
    repos.set(e.repo, r);
  }

  const totalRules = entries.length;
  const totalRuns = entries.reduce((a, e) => a + e.runs, 0);
  const stale = entries.filter((e) => days(e.lastVerifiedAt) > 30).length;

  const repoRows = [...repos.entries()].map(([repo, s]) => `
      <tr>
        <td class="repo">${esc(repo)}</td>
        <td>${s.rules}</td>
        <td>${s.runs}</td>
        <td>${s.stale > 0 ? `<span class="warn">${s.stale} stale</span>` : '<span class="ok">fresh</span>'}</td>
      </tr>`).join("");

  const ruleRows = entries.slice(0, 100).map((e) => `
      <tr>
        <td class="repo">${esc(e.repo)}</td>
        <td>${esc(e.rule.statement.length > 90 ? e.rule.statement.slice(0, 90) + "…" : e.rule.statement)}</td>
        <td><span class="tag ${esc(e.rule.phase)}">${esc(e.rule.phase)}</span></td>
        <td>${e.runs}</td>
        <td>${days(e.lastVerifiedAt)}d ago</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VeriFact — Verification Debt</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .sub { color: #8b949e; margin-bottom: 2rem; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.5rem; min-width: 140px; }
  .card .n { font-size: 1.8rem; font-weight: 700; }
  .card .l { color: #8b949e; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .6rem .9rem; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  td.repo { font-family: ui-monospace, monospace; color: #79c0ff; }
  .ok { color: #3fb950; } .warn { color: #d29922; }
  .tag { font-size: .75rem; padding: .15rem .5rem; border-radius: 10px; background: #21262d; }
  .tag.business_rule { color: #a371f7; } .tag.error_handling { color: #f85149; } .tag.happy_path { color: #3fb950; } .tag.state { color: #58a6ff; }
  footer { color: #8b949e; font-size: .8rem; }
</style>
</head>
<body>
  <h1>VeriFact</h1>
  <p class="sub">Runtime behavioral verification — proven intent per repository</p>

  <div class="cards">
    <div class="card"><div class="n">${totalRules}</div><div class="l">verified rules</div></div>
    <div class="card"><div class="n">${repos.size}</div><div class="l">repositories</div></div>
    <div class="card"><div class="n">${totalRuns}</div><div class="l">ledger rule runs</div></div>
    <div class="card"><div class="n" class="${stale ? "warn" : "ok"}">${stale}</div><div class="l">stale (&gt;30d)</div></div>
  </div>

  <h2>Repositories</h2>
  <table>
    <thead><tr><th>Repo</th><th>Rules</th><th>Runs</th><th>Freshness</th></tr></thead>
    <tbody>${repoRows || '<tr><td colspan="4" style="color:#8b949e">No repos yet — run verification on a PR to populate the ledger.</td></tr>'}</tbody>
  </table>

  <h2>Recent rules</h2>
  <table>
    <thead><tr><th>Repo</th><th>Intent (verbatim)</th><th>Phase</th><th>Runs</th><th>Last verified</th></tr></thead>
    <tbody>${ruleRows || '<tr><td colspan="5" style="color:#8b949e">Empty ledger.</td></tr>'}</tbody>
  </table>

  <footer>VeriFact — every rule here is machine-checkable intent that re-verifies on every future PR.</footer>
</body>
</html>`;
}
