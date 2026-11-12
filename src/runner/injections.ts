/**
 * Failure injection middleware.
 *
 * A tiny HTTP proxy that sits in front of the app inside the sandbox and
 * degrades traffic according to VERIFACT_FAULT. Target apps don't need any
 * instrumentation — the fault is applied at the wire, so "AI code assumes the
 * happy path" failures become observable.
 */
import http from "node:http";
import { URL } from "node:url";

export type Fault = "none" | "db_down" | "timeout" | "upstream_5xx" | "slow_downstream";

const PORT = Number(process.env.VERIFACT_PROXY_PORT ?? 3999);
const TARGET = process.env.VERIFACT_TARGET_URL ?? "http://127.0.0.1:3000";

export function startFaultProxy(): Promise<void> {
  const server = http.createServer((req, res) => {
    const fault = (process.env.VERIFACT_FAULT ?? "none") as Fault;
    const target = new URL(req.url ?? "/", TARGET);

    if (fault === "db_down" || fault === "upstream_5xx") {
      // Simulate dependency failure at the proxy edge for any request the
      // benchmark marks as dependency-touching (header-driven), or /health.
      if ((req.headers["x-verifact-dependency"] ?? req.url?.startsWith("/health"))) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "dependency unavailable (injected)" }));
        return;
      }
    }
    if (fault === "timeout") {
      setTimeout(() => {
        res.writeHead(504);
        res.end(JSON.stringify({ error: "timeout (injected)" }));
      }, 30_000);
      return;
    }

    const upstream = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: "upstream unreachable" }));
    });
    req.pipe(upstream);
  });

  return new Promise((resolve) => server.listen(PORT, () => resolve()));
}
