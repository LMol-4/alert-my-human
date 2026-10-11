# alert-my-human

Let your agent notify you when a task finishes, a job fails, or it needs your attention. Send alerts through email, Slack, Telegram, SMS, or webhooks.

A small MCP server for personal automations. No database, queue, or background service. Bring your own provider credentials; hosting and notification providers may charge for usage.

## Quick start (MCP server)

### 1. Choose a channel

Configure just one to begin. Leave the other variables unset.

| Channel | Variables | Setup |
| --- | --- | --- |
| `email` | `RESEND_API_KEY`, `SENDING_EMAIL`, `ALERT_EMAIL` (comma-separated for several) | [Resend](https://resend.com/docs/send-with-nodejs): API key and a verified sending domain |
| `slack` | `SLACK_WEBHOOK_URL` | [Incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/); treat the URL as a secret |
| `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Create a bot with [@BotFather](https://t.me/BotFather), message it, then read `message.chat.id` from [getUpdates](https://core.telegram.org/bots/api#getupdates) |
| `sms` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_PHONE_NUMBER` | [Twilio](https://www.twilio.com/docs/messaging/quickstart); numbers in international format, e.g. `+353...` |
| webhooks | `WEBHOOK_URLS`, optional `WEBHOOK_SECRET` | See [Webhooks](#webhooks) |

Set `AUTH_API_KEY` to a long random secret, separate from your provider credentials:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 2. Run the server

**Vercel — no local server to keep running:**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLMol-4%2Falert-my-human&env=AUTH_API_KEY&envDescription=A%20random%20secret%20callers%20send%20as%20a%20bearer%20token&envLink=https%3A%2F%2Fgithub.com%2FLMol-4%2Falert-my-human%23quick-start-mcp-server)

Enter `AUTH_API_KEY` when prompted. Add your channel variables in the project's [environment settings](https://vercel.com/docs/environment-variables/managing-environment-variables) for Production, then redeploy so they take effect. Your endpoint is `https://<your-domain>/api/mcp`.

**Locally — Node.js 24 and pnpm 12.9.1:**

```sh
git clone https://github.com/LMol-4/alert-my-human.git
cd alert-my-human
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env`, set your key and channel variables, then run `pnpm dev`. The endpoint is `http://localhost:3000/api/mcp`. Keep the process running; a remote client cannot reach your computer's localhost.

### 3. Connect your agent

Use an MCP client that supports HTTP servers with custom headers. For clients using `mcpServers` configuration:

```json
{
  "mcpServers": {
    "alert-my-human": {
      "type": "http",
      "url": "https://<your-domain>/api/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_API_KEY>"
      }
    }
  }
}
```

Replace both placeholders; use the localhost URL for a local client. Keep the real token out of committed client configuration. [Claude Code configuration guidance](https://code.claude.com/docs/en/mcp).

### 4. Send your first alert

Ask your agent: **“Use alert-my-human to list my channels, then send a test alert through one of them.”**

`list_channels` takes no arguments and also reports partly configured channels. Example `send_alert` arguments, if email is configured:

```json
{
  "channels": ["email"],
  "title": "It works!",
  "message": "Your agent can reach you."
}
```

Required: `channels`, `title` (up to 250 characters), and `message` (up to 4000). Optional: `severity` (`info`, `success`, `warning`, `error`; default `info`), `context` (up to 20 string key/value pairs), and `idempotencyKey` (reuse it when retrying the same alert).

## Results

Each channel gets its own result:

```json
{ "destination": "telegram", "outcome": "accepted", "attempts": 1, "durationMs": 212, "providerId": "42" }
{ "destination": "email", "outcome": "unknown", "attempts": 1, "durationMs": 10003, "error": { "code": "TIMEOUT", "message": "No response within 10s" } }
```

| Outcome | Meaning |
| --- | --- |
| `accepted` | The provider accepted it. This does not prove it was received or read. |
| `rejected` | The provider or a pre-send check refused it. |
| `unknown` | No clear answer, e.g. a timeout; it may have been delivered. |
| `not_attempted` | Not sent, e.g. an unknown channel name. |

Errors use a code (`TIMEOUT`, `NETWORK`, `HTTP_ERROR`, `RATE_LIMITED`, `INVALID_PAYLOAD`, `ABORTED`, `UNKNOWN_DESTINATION`, `PROVIDER_ERROR`) and a short message without URLs or credentials. `send_alert` returns them as structured content plus a text summary. It sets `isError` only when no destination accepted; on partial success, retry only the channels that failed.

## Delivery behavior

- Each attempt times out after 10 seconds, and a send stops starting attempts after 25 seconds.
- At most two attempts per destination. Rate limits (429) and server errors (5xx) are retried, honoring the provider's retry delay when it fits the deadline. Failures to connect are retried. 4xx responses are not.
- Timeouts and dropped connections are not retried, since the provider may already have the alert. Exception: email with an `idempotencyKey`, which Resend deduplicates.
- `idempotencyKey` is forwarded per destination as `<key>:<destination>` to Resend and to webhooks. It is not a universal guarantee; duplicates are still possible.
- Messages must fit each provider's limit (Slack 3000 characters per section, Telegram 4096, SMS 1600) or are rejected before sending. Keep messages brief.
- Nothing is stored and no work survives shutdown. Scheduling and durable retries are up to the caller.

## Webhooks

`WEBHOOK_URLS` takes one URL or a comma-separated list. Name entries with `name=url` (for example `home=https://...`); unnamed ones are called `webhook`, or `webhook-1`, `webhook-2`, ... when there are several. Each is its own destination with its own result. `WEBHOOK_SECRET`, if set, is sent as `Authorization: Bearer <secret>`.

Each receives a POST with `Content-Type: application/json`:

```json
{
  "id": "5f0c1c1e-...",
  "severity": "info",
  "title": "Task complete",
  "message": "Your export is ready.",
  "context": { "job": "export" }
}
```

`id` is unique per send and stays the same across retries and destinations. `context` is optional. Redirects are not followed. Errors report only the HTTP status.

## If something goes wrong

| Symptom | Check |
| --- | --- |
| Unauthorized | The server key and `Bearer <key>` header match. |
| No channels listed | All variables for a channel are set; restart locally or redeploy. `list_channels` names missing variables. |
| `rejected` with `HTTP_ERROR` | Check credentials and recipient permissions. Except for webhooks, the message includes the provider's reason. |
| `INVALID_PAYLOAD` | Shorten the message or context for that channel. |
| Browser shows no page | This is an MCP endpoint, not a website; connect through your client. |

## Development

`pnpm check` runs lint, types, and tests; `pnpm build:checked` adds a production build. Tests mock providers and send nothing real. To add a provider, add a factory in `src/lib/providers.ts` using the shared `request` helper, then register its variables in `src/lib/env.ts`.

The MCP tool arguments follow semantic versioning from 1.0; before then, minor versions may change them. Report security issues privately through [GitHub security advisories](https://github.com/LMol-4/alert-my-human/security/advisories/new). [MIT license](LICENSE).
