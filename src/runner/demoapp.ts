/**
 * Benchmark demo app: a pricing/quote API with intentionally parameterizable
 * business logic and injectable "hallucinated logic" bugs — the exact class of
 * defect diff-readers miss.
 *
 * POST /quote  { price, quantity, taxRate }
 *   subtotal  = price * quantity
 *   discount  = min(subtotal * rate, cap)      // intent: rate% BEFORE tax, capped
 *   taxable   = subtotal - discount
 *   total     = max(taxable * (1 + taxRate), minCharge)
 *
 * Bug flags represent what an agent "almost right" build typically gets wrong.
 */
import http from "node:http";

export interface BugFlags {
  applyAfterTax?: boolean;   // hallucination: discount applied after tax
  capIgnored?: boolean;      // hallucination: cap dropped
  floorIgnored?: boolean;    // hallucination: min charge dropped
  silentOnDbDown?: boolean;  // hallucination: returns 200 with garbage when dependency fails
}

export interface QuoteRequest { price: number; quantity: number; taxRate: number; }
export interface QuoteParams { rate: number; cap: number; minCharge: number; }

export function computeQuote(
  req: QuoteRequest, params: QuoteParams, bugs: BugFlags = {},
): { subtotal: number; discount: number; total: number } {
  const subtotal = round2(req.price * req.quantity);
  if (bugs.applyAfterTax) {
    const taxed = subtotal * (1 + req.taxRate);
    const discount = Math.min(taxed * (params.rate / 100), bugs.capIgnored ? Infinity : params.cap);
    const total = Math.max(taxed - discount, bugs.floorIgnored ? 0 : params.minCharge);
    return { subtotal, discount: round2(discount), total: round2(total) };
  }
  const discount = Math.min(subtotal * (params.rate / 100), bugs.capIgnored ? Infinity : params.cap);
  const taxable = subtotal - discount;
  const total = Math.max(taxable * (1 + req.taxRate), bugs.floorIgnored ? 0 : params.minCharge);
  return { subtotal, discount: round2(discount), total: round2(total) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Plain-node HTTP app factory used by the sandbox runner in benchmark mode. */
export function startDemoApp(port: number, params: QuoteParams, bugs: BugFlags): () => void {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/quote") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (process.env.VERIFACT_FAULT === "db_down" && !bugs.silentOnDbDown) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unavailable" }));
          return;
        }
        let parsed: QuoteRequest;
        try {
          parsed = JSON.parse(body || "{}") as QuoteRequest;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
          return;
        }
        const out = computeQuote(parsed, params, bugs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return () => server.close();
}
