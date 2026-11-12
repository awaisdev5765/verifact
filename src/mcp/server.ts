/**
 * VeriFact MCP server (stdio, JSON-RPC 2.0).
 * Tool: verify_change — "verify this change" from inside Cursor / Claude Code.
 */
import { readFileSync } from "node:fs";
import { verify } from "../pipeline.js";
import { renderComment } from "../report/pr-comment.js";
import { llmFromEnv } from "../intent/llm.js";

interface RpcMsg {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

const TOOLS = [
  {
    name: "verify_change",
    description:
      "Verify that code changes satisfy the stated intent, by executing them in a sandbox. Pass the repo directory and the intent text (PR description, ticket, or spec).",
    inputSchema: {
      type: "object",
      properties: {
        repoDir: { type: "string", description: "Path to the repo working tree" },
        intent: { type: "string", description: "Human statement of intent for the change" },
        startCmd: { type: "string", description: "Command that starts the app, default 'npm start'" },
        port: { type: "number", description: "Port the app listens on, default 3000" },
      },
      required: ["repoDir", "intent"],
    },
  },
];

function send(msg: RpcMsg): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

for await (const line of process.stdin) {
  const text = String(line).trim();
  if (!text) continue;
  let msg: RpcMsg;
  try {
    msg = JSON.parse(text);
  } catch {
    continue;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "verifact", version: "0.1.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: a } = msg.params ?? {};
    if (name !== "verify_change") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
      continue;
    }
    try {
      const intent = (a as any).intent;
      const intentText =
        typeof intent === "string" && intent.includes("/")
          ? readFileSync(intent, "utf8") // allow a path to an intent file
          : intent;
      const report = await verify({
        repo: (a as any).repoDir,
        intentText,
        target: (a as any).repoDir,
        startCmd: (a as any).startCmd ?? "npm start",
        port: (a as any).port ?? 3000,
        llm: llmFromEnv(),
      });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: renderComment(report) }],
          isError: report.summary.violated > 0,
        },
      });
    } catch (e: any) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
