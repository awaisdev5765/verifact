/**
 * LLM adapters for intent extraction.
 *
 * The deterministic parser always runs; the LLM only PROPOSES additional
 * rules. Configure via environment:
 *
 *   VERIFACT_LLM_PROVIDER = openai | anthropic | openai_compat
 *   VERIFACT_LLM_API_KEY  = sk-...            (never committed)
 *   VERIFACT_LLM_MODEL    = gpt-4o-mini | claude-sonnet-4-5 | ...
 *   VERIFACT_LLM_BASE_URL = https://...       (openai_compat; for local/OSS models)
 *
 * No key -> no LLM proposals, coverage never regresses below deterministic.
 */
import { LlmClient } from "./extract.js";

export function llmFromEnv(): LlmClient | undefined {
  const key = process.env.VERIFACT_LLM_API_KEY;
  if (!key) return undefined;
  const provider = process.env.VERIFACT_LLM_PROVIDER ?? "openai";
  const model = process.env.VERIFACT_LLM_MODEL ?? (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini");
  const baseUrl =
    process.env.VERIFACT_LLM_BASE_URL ??
    (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com");

  if (provider === "anthropic") return anthropicClient(key, model, baseUrl);
  return openAiClient(key, model, baseUrl);
}

export function openAiClient(key: string, model: string, baseUrl: string): LlmClient {
  return {
    async complete(system, user) {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

export function anthropicClient(key: string, model: string, baseUrl: string): LlmClient {
  return {
    async complete(system, user) {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { content: Array<{ text?: string }> };
      return json.content?.map((c) => c.text ?? "").join("") ?? "";
    },
  };
}
