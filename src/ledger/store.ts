/**
 * Rule ledger — the compounding moat.
 *
 * Every rule that VERIFIES against a repo's current behavior is persisted.
 * Future PRs are verified against fresh intent rules PLUS the ledger, so
 * yesterday's intent becomes a permanent regression net: if a later agent
 * change reintroduces a hallucination that was previously fixed, the ledger
 * catches it even when the new PR description says nothing about it.
 *
 * Storage: one JSON file per install (v0). Same interface will back SQLite/
 * Postgres in v1. Rules are keyed by fingerprint = hash(normalized statement
 * + phase), so restated intent dedupes cleanly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Rule } from "../rules/schema.js";

export interface LedgerEntry {
  fingerprint: string;
  repo: string;
  rule: Rule;
  /** when this rule last verified successfully */
  lastVerifiedAt: string;
  /** times this rule has been run across PRs */
  runs: number;
}

export interface LedgerData {
  version: 1;
  entries: Record<string, LedgerEntry>; // key = repo + ":" + fingerprint
}

export function fingerprint(rule: Rule): string {
  const norm = rule.statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${rule.phase}|${norm}`).digest("hex").slice(0, 24);
}

export class Ledger {
  private data: LedgerData = { version: 1, entries: {} };
  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as LedgerData;
      if (parsed?.version === 1 && parsed.entries) this.data = parsed;
    } catch {
      // corrupt ledger must never crash verification: start empty
      this.data = { version: 1, entries: {} };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  /** Rules previously verified for this repo (the regression net). */
  rulesFor(repo: string): Rule[] {
    return Object.values(this.data.entries)
      .filter((e) => e.repo === repo)
      .map((e) => e.rule);
  }

  /**
   * Record the outcome of a verification run.
   *  - rules that VERIFIED are persisted (or refreshed) — they are now proven
   *    intent for this repo
   *  - rules that VIOLATED are never persisted: unproven intent is not a
   *    regression net, it's a pending question
   *  - UNTESTABLE rules are not persisted either
   */
  record(repo: string, results: Array<{ rule: Rule; verdict: string }>, now = new Date()): { added: number; refreshed: number } {
    let added = 0;
    let refreshed = 0;
    for (const r of results) {
      if (r.verdict !== "VERIFIED") continue;
      const fp = fingerprint(r.rule);
      const key = `${repo}:${fp}`;
      const existing = this.data.entries[key];
      if (existing) {
        existing.lastVerifiedAt = now.toISOString();
        existing.rule = r.rule; // assertions may have improved
        existing.runs += 1;
        refreshed += 1;
      } else {
        this.data.entries[key] = {
          fingerprint: fp,
          repo,
          rule: r.rule,
          lastVerifiedAt: now.toISOString(),
          runs: 1,
        };
        added += 1;
      }
    }
    if (added + refreshed > 0) this.save();
    return { added, refreshed };
  }

  /**
   * Drop stale entries: rules not verified within maxAgeDays are removed —
   * the codebase has moved on and the rule no longer reflects live intent.
   */
  prune(repo: string, maxAgeDays = 90, now = new Date()): number {
    const cutoff = now.getTime() - maxAgeDays * 86_400_000;
    const before = Object.keys(this.data.entries).length;
    for (const [key, e] of Object.entries(this.data.entries)) {
      if (e.repo === repo && new Date(e.lastVerifiedAt).getTime() < cutoff) {
        delete this.data.entries[key];
      }
    }
    const removed = before - Object.keys(this.data.entries).length;
    if (removed > 0) this.save();
    return removed;
  }

  stats(repo?: string): { total: number; repos: number; runs: number } {
    const all = this.entries(repo);
    return {
      total: all.length,
      repos: new Set(all.map((e) => e.repo)).size,
      runs: all.reduce((a, e) => a + e.runs, 0),
    };
  }

  /** All entries, optionally scoped to a repo (dashboard/reporting). */
  entries(repo?: string): LedgerEntry[] {
    return Object.values(this.data.entries).filter((e) => !repo || e.repo === repo);
  }

  /** Test/maintenance hook. */
  clear(): void {
    this.data = { version: 1, entries: {} };
    if (existsSync(this.filePath)) rmSync(this.filePath);
  }
}

/**
 * Merge policy: fresh intent rules win on statement collisions; ledger rules
 * fill in everything the new PR description doesn't cover. Ledger rules are
 * re-keyed (LG-…) so their ids can never collide with a fresh PR's ids.
 */
export function mergeRules(fresh: Rule[], ledger: Rule[]): Rule[] {
  const seen = new Set(fresh.map((r) => fingerprint(r)));
  const merged = [...fresh];
  for (const l of ledger) {
    if (seen.has(fingerprint(l))) continue;
    merged.push({ ...l, id: `LG-${fingerprint(l).slice(0, 8)}` });
  }
  return merged;
}

export function defaultLedgerPath(): string {
  return process.env.VERIFACT_LEDGER_PATH ?? join(process.env.HOME ?? ".", ".verifact", "ledger.json");
}
