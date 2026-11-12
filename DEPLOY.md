# Deploying VeriFact as a hosted service

This ships the full product: GitHub App webhook + sandbox verification +
rule ledger + dashboard, running in the cloud.

## Option A — Fly.io (recommended: volumes + Machines)

```bash
# 1. one-time
brew install flyctl && fly auth login

# 2. from the verifact directory
fly launch --no-deploy            # picks up fly.toml
fly volumes create verifact_data --size 3 --region iad
fly secrets set VERIFACT_WEBHOOK_SECRET=$(openssl rand -hex 32)
fly secrets set GITHUB_TOKEN=github_pat_...
fly secrets set VERIFACT_LLM_PROVIDER=openai
fly secrets set VERIFACT_LLM_API_KEY=sk-...
fly secrets set VERIFACT_LLM_MODEL=gpt-4o-mini
fly secrets set VERIFACT_TARGET=/repos/target VERIFACT_START_CMD="npm start"
fly deploy

# 3. note the URL
fly status   # e.g. https://verifact.fly.dev
```

The webhook URL for the GitHub App manifest is `https://<your-app>.fly.dev/webhook`.

## Option B — Render.com

1. Push this repo to GitHub
2. Render dashboard → New → Blueprint → select the repo (uses `render.yaml`)
3. Fill in the sync:false secrets when prompted
4. Webhook URL: `https://<service>.onrender.com/webhook`

## Option C — Any Docker host

```bash
docker build -t verifact .
docker run -p 8080:8080 \
  -e VERIFACT_WEBHOOK_SECRET=... -e GITHUB_TOKEN=... \
  -e VERIFACT_TARGET=/repos/target -e VERIFACT_START_CMD="npm start" \
  -v verifact-data:/data verifact
```

## Verify the deployment

```bash
curl https://<host>/healthz
# {"ok":true,"llm":true,"ledger":"/data/ledger.json"}

open https://<host>/        # dashboard (starts empty)
```

## Sandbox verification in the cloud

The verification target must be runnable. Two supported patterns:

1. **Monorepo/target baked into the image** — extend the Dockerfile:
   ```dockerfile
   COPY --from=build /app/dist ./dist
   COPY --from=build /app/package.json ./package.json
   RUN git clone https://github.com/you/target-repo /repos/target && cd /repos/target && npm ci
   ```
   Set `VERIFACT_TARGET=/repos/target`.

2. **Per-install self-hosted runner** (enterprise): customers run the same
   image inside their VPC; the ledger file syncs however they choose.
   Sandbox runs never need `GITHUB_TOKEN` — that's only for PR comments.

## GitHub App final wiring

1. GitHub → Settings → Developer settings → GitHub Apps → **New**
2. Paste `github-app/manifest.yml`, replacing the webhook URL with
   `https://<your-host>/webhook`
3. Copy the generated webhook secret:
   `fly secrets set VERIFACT_WEBHOOK_SECRET=<secret>`
4. Install the app on your repos, open a PR with testable intent
5. Watch the verdict comment appear, then the dashboard populate

## Operations

- `GET /healthz` — probe endpoint (reports LLM and ledger status)
- `GET /` or `/dashboard` — verification-debt dashboard
- `POST /webhook` — GitHub events only; 401 on bad HMAC signature
- Ledger persists on the mounted volume; survive redeploys
- Logs: `fly logs` / Render dashboard — every verification outcome is logged
