# VeriFact GitHub App — setup

## 1. Create the app (5 minutes)

Go to https://github.com/settings/apps/new and paste `manifest.yml` from this
directory when using the **manifest flow** (GitHub pre-fills everything), or
set manually:

- **Webhook URL**: your public endpoint, e.g. `https://<your-host>/webhook`
  (dev: use `smee.io` — `npx smee-client --url <smee-url> --port 8080`)
- **Webhook secret**: generate with `openssl rand -hex 32`
- **Permissions**:
  - Pull requests: Read & write (post comments)
  - Contents: Read-only (check out PR head for sandbox runs)
  - Metadata: Read-only
- **Subscribe to events**: Pull request
- **Where can this app be installed**: Any account (for dogfooding: Only this account)

## 2. Run the webhook server

```bash
export VERIFACT_WEBHOOK_SECRET=<secret from step 1>
export GITHUB_TOKEN=<a PAT with repo access for posting comments>
export VERIFACT_TARGET=/path/to/checked-out-repo
export VERIFACT_START_CMD="npm start"
npm run server
```

## 3. LLM extraction (optional but recommended)

```bash
export VERIFACT_LLM_PROVIDER=openai        # or anthropic
export VERIFACT_LLM_API_KEY=sk-...
export VERIFACT_LLM_MODEL=gpt-4o-mini
```

## 4. Test end-to-end

1. Install the app on a test repo
2. Open a PR whose body states testable intent, e.g.
   `POST /quote must return 200. Discounts are capped at $50.`
3. VeriFact posts a verdict table comment on the PR

## Local dev without a public URL

```bash
npx smee-client --url https://smee.io/your-channel --port 8080 &
npm run server
```

## Security notes

- The webhook secret is HMAC-verified (`sha256=`, timing-safe compare)
- `GITHUB_TOKEN` is used only for posting PR comments; sandbox runs never
  receive it
- For enterprise, the runner binary executes inside the customer VPC so app
  secrets never leave
