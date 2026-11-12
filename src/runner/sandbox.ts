/**
 * Sandbox runner.
 *
 * Provisions an isolated environment for the target app, seeds data, runs the
 * generated test script, and tears down. Two modes:
 *  - docker (preferred): one container per PR, torn down after the run
 *  - local (fallback / dev): spawn the app in the working tree directly
 *
 * Enterprise runs the same runner inside their VPC — secrets never leave.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Rule, RuleResult, Verdict } from "../rules/schema.js";
import { generateTestScript } from "../testgen/generate.js";

export interface SandboxOptions {
  /** path to repo working tree (local mode) or image name (docker mode) */
  target: string;
  mode?: "auto" | "docker" | "local";
  /** command that starts the app, e.g. "npm run dev" */
  startCmd?: string;
  port?: number;
  timeoutMs?: number;
}

export function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export async function runInSandbox(rules: Rule[], opts: SandboxOptions): Promise<RuleResult[]> {
  const mode = opts.mode && opts.mode !== "auto" ? opts.mode : hasDocker() ? "docker" : "local";
  const dir = mkdtempSync(join(tmpdir(), "verifact-"));
  const testFile = join(dir, "rules.test.mjs");
  writeFileSync(testFile, generateTestScript(rules));

  try {
    if (mode === "docker") {
      return await runDocker(opts, testFile);
    }
    return await runLocal(opts, testFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runDocker(opts: SandboxOptions, testFile: string): Promise<RuleResult[]> {
  const name = `verifact-${Date.now()}`;
  const port = opts.port ?? 3000;
  const start = opts.startCmd ?? "npm start";
  const container = spawn("docker", [
    "run", "--rm", "--name", name, "-d", "-p", `${port}:${port}`, opts.target,
    "sh", "-c", start,
  ]);
  await exit(container, 60_000);
  try {
    await waitReady(port, 30_000);
    return await execTests(testFile, port, opts.timeoutMs ?? 120_000);
  } finally {
    spawnSync("docker", ["stop", name], { stdio: "ignore" });
  }
}

async function runLocal(opts: SandboxOptions, testFile: string): Promise<RuleResult[]> {
  const port = opts.port ?? 3000;
  const start = opts.startCmd ?? "npm start";
  const app = spawn("sh", ["-c", start], { cwd: opts.target, stdio: "ignore", detached: true });
  try {
    await waitReady(port, 30_000);
    return await execTests(testFile, port, opts.timeoutMs ?? 120_000);
  } finally {
    try { process.kill(-app.pid!); } catch { /* already gone */ }
  }
}

async function execTests(testFile: string, port: number, timeoutMs: number): Promise<RuleResult[]> {
  // The generated script exports `results`; execute it in-process against the
  // sandboxed app (the app is the thing that must be isolated, not the driver).
  const prevBase = process.env.VERIFACT_BASE_URL;
  process.env.VERIFACT_BASE_URL = `http://127.0.0.1:${port}`;
  let rawResults: Array<{ id: string; verdict: Verdict; detail: string; durationMs: number }>;
  try {
    const mod = await Promise.race([
      import(pathToFileURL(testFile).href),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`test script exceeded ${timeoutMs}ms`)), timeoutMs)),
    ]);
    rawResults = (mod as { results: typeof rawResults }).results;
    if (!Array.isArray(rawResults)) throw new Error("script exported no results array");
  } catch (e) {
    return [{
      rule: { id: "RUNNER", statement: "(script failure)", phase: "happy_path", assertions: [], confidence: 0, source: { kind: "inferred" } },
      verdict: "UNTESTABLE",
      detail: `test script failed to execute: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: 0,
    }];
  } finally {
    if (prevBase === undefined) delete process.env.VERIFACT_BASE_URL;
    else process.env.VERIFACT_BASE_URL = prevBase;
  }
  return rawResults.map((p) => ({
    rule: { id: p.id.split("#")[0], statement: "(see assertion)", phase: "happy_path", assertions: [], confidence: 1, source: { kind: "inferred" } },
    verdict: p.verdict,
    detail: p.detail,
    durationMs: p.durationMs,
  }));
}

function waitReady(port: number, timeoutMs: number): Promise<void> {
  // Readiness = the port accepts TCP connections. We do NOT wait for a
  // successful HTTP response: a server that 404s on / or is slow to respond is
  // still up, and judging its behavior is the tests' job, not the runner's.
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error("sandbox app did not become ready"));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function exit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill(); reject(new Error("timeout starting sandbox")); }, timeoutMs);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}
