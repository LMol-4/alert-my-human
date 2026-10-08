# alert-my-human

A lightweight MCP server that lets agents send multichannel alerts — useful for notifying a human when a scheduled job fails, data is missing, or something otherwise needs attention.

Supports email, Slack, Telegram, SMS, and generic webhooks. Enabled a channel by setting its env vars. Callers pick which configured channels to deliver to on each call.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLMol-4%2Falert-my-human&env=AUTH_API_KEY&envDescription=A%20random%20secret%20callers%20send%20as%20a%20bearer%20token&envLink=https%3A%2F%2Fgithub.com%2FLMol-4%2Falert-my-human%23setup)

One-click deploy prompts only for `AUTH_API_KEY` (the one required var). Add whichever channel vars you want afterward in the Vercel dashboard (Project → Settings → Environment Variables) — see [Setup](#setup) below.

## Tools

### `list_channels`

Returns which channels are currently configured. No params. Call this before `send_alert` to know which channel names are valid.

### `send_alert`

| Param      | Type                              | Required | Description                                                        |
| ---------- | --------------------------------- | -------- | -------------------------------------------------------------------- |
| `channels` | array of channel names            | Yes      | Which channels to deliver to (e.g. `["slack", "email"]`). See `list_channels`. |
| `severity` | `info` \| `success` \| `warning` \| `error` | No (default `info`) | Controls the color/emoji used in the alert.               |
| `title`    | string                            | Yes      | Short headline for the alert.                                        |
| `message`  | string                            | Yes      | Body of the alert.                                                    |
| `context`  | object of string key/value pairs  | No       | Extra details rendered as a list (e.g. job name, error code).        |

Channels are delivered independently, so one failing channel doesn't block the others — the response reports which channels sent and which failed. HTTP deliveries use a 10s timeout per attempt and retry once after 500ms on a transient failure (network error, timeout, HTTP 429, or 5xx). Email SDK calls have a 10s timeout and are not retried. The route allows 30s so the HTTP retry budget can finish. A timeout does not prove a provider rejected a message, so retries can occasionally produce duplicate alerts.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `AUTH_API_KEY` — any random secret string; callers must send it as `Authorization: Bearer <key>`.
   - Then configure one or more channels (leave a channel's vars unset to disable it):
     - **Email** — `SENDING_EMAIL`, `RESEND_API_KEY` (from [resend.com](https://resend.com)), `ALERT_EMAIL` (one address, or several comma-separated).
     - **Slack** — `SLACK_WEBHOOK_URL` (an [incoming webhook](https://api.slack.com/messaging/webhooks)).
     - **Telegram** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
     - **SMS** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_PHONE_NUMBER` (from [twilio.com](https://twilio.com)).
     - **Webhook** — `WEBHOOK_URLS`, comma-separated; each receives the alert as JSON.
2. Use Node.js 24 and pnpm 12.9.1, then run `pnpm install`
3. `pnpm dev`

## Connecting an MCP client

Register the server with a static bearer token header, for example in Claude Code's `mcpServers` config:

```json
{
  "type": "http",
  "url": "https://your-deployment.example.com/api/mcp",
  "headers": {
    "Authorization": "Bearer <AUTH_API_KEY>"
  }
}
```

## Testing

Run `pnpm test` for automated regression tests (provider requests are mocked), `pnpm lint` for lint checks, and `pnpm typecheck` for TypeScript checks. `pnpm check` runs all three; `pnpm build:checked` also makes a production build. Tests require no provider credentials and send no real alerts.

Run `npx @modelcontextprotocol/inspector@latest http://localhost:3000 undefined`, then connect it to `http://localhost:3000/api/mcp` with an `Authorization: Bearer <AUTH_API_KEY>` header.

## CI and Vercel deployments

The GitHub Actions workflow runs lint, type checks, tests, and a production build on pull requests, pushes to `main`, and merge-queue updates. It uses Node.js 24, pinned pnpm, a frozen lockfile, and a dependency cache. It needs no deployment or provider secrets, so fork pull requests can run the same checks.

Keep the [Vercel Git integration](https://vercel.com/docs/git/vercel-for-github) connected: branch pushes create previews, and merges to the configured production branch create production deployments. `vercel.json` runs `pnpm build:checked` as the build command, so a failing test, lint check, or type check stops both preview and production builds. Its explicit install/build commands use the same pnpm version as CI instead of relying on Vercel's lockfile-based package-manager detection. Update both commands when changing `packageManager` in `package.json`.

For merge and release protection, complete these one-time dashboard settings after the first CI run:

1. In GitHub branch protection or rulesets for `main`, require the **Quality checks** status before merging. Require an up-to-date branch or use a merge queue.
2. In Vercel project settings, open **Deployment Checks**, add a **GitHub** check, and select **Quality checks**. Keep automatic production-domain assignment enabled. This holds production promotion until CI passes on the deployed commit. These dashboard settings are not enabled by committing the workflow.
3. Keep production channel credentials scoped to Production. Use test destinations for any manually exercised preview environment; the automated tests mock provider calls.

GitHub CI and Vercel builds can run concurrently. The build-command gate protects each deployment itself; [Deployment Checks](https://vercel.com/docs/deployment-checks) additionally gate production promotion on GitHub's result. Vercel also offers native lint/typecheck checks, but those alone do not run this test suite. A successful preview does not replace checks on the merged production commit.

Vercel's [CLI-based GitHub Actions workflow](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel) (`vercel build` followed by `vercel deploy --prebuilt`) is an alternative when deployment must be owned entirely by CI. This project uses Git integration, so no Vercel token or second deployment workflow is needed.

## Roadmap

- Phone call alerts
