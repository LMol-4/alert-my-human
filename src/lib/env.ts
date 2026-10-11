import { email, slack, sms, telegram, webhook } from './providers';
import type { Provider } from './types';

type Env = Record<string, string | undefined>;

const CHANNELS: Array<[string, string[], (env: Env) => Provider]> = [
  ['email', ['RESEND_API_KEY', 'SENDING_EMAIL', 'ALERT_EMAIL'], (env) =>
    email({ apiKey: env.RESEND_API_KEY!, from: env.SENDING_EMAIL!, to: env.ALERT_EMAIL! })],
  ['slack', ['SLACK_WEBHOOK_URL'], (env) => slack({ webhookUrl: env.SLACK_WEBHOOK_URL! })],
  ['telegram', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], (env) =>
    telegram({ token: env.TELEGRAM_BOT_TOKEN!, chatId: env.TELEGRAM_CHAT_ID! })],
  ['sms', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'ALERT_PHONE_NUMBER'], (env) =>
    sms({ accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!, from: env.TWILIO_FROM_NUMBER!, to: env.ALERT_PHONE_NUMBER! })],
];

/**
 * Builds destinations from the documented environment variables. A channel whose
 * variables are all unset is skipped; a partly or wrongly set one is reported in
 * `errors` (by variable name, never value) instead of throwing.
 */
export function destinationsFromEnv(env: Env = process.env) {
  const destinations: Record<string, Provider> = {};
  const errors: string[] = [];
  const add = (name: string, build: () => Provider) => {
    try {
      destinations[name] = build();
    } catch (error) {
      errors.push((error as Error).message);
    }
  };

  for (const [name, keys, build] of CHANNELS) {
    const missing = keys.filter((key) => !env[key]?.trim());
    if (missing.length === keys.length) continue;
    if (missing.length) errors.push(`${name}: missing ${missing.join(', ')}`);
    else add(name, () => build(env));
  }

  // WEBHOOK_URLS entries are `url` or `name=url`; one unnamed URL is called `webhook`.
  const entries = (env.WEBHOOK_URLS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const headers = env.WEBHOOK_SECRET?.trim() ? { Authorization: `Bearer ${env.WEBHOOK_SECRET.trim()}` } : undefined;
  entries.forEach((entry, i) => {
    const named = /^([a-z0-9_-]+)=(.+)$/i.exec(entry);
    const name = named ? named[1] : entries.length === 1 ? 'webhook' : `webhook-${i + 1}`;
    if (destinations[name]) errors.push(`WEBHOOK_URLS: duplicate name ${name}`);
    else add(name, () => webhook({ url: named ? named[2] : entry, headers }));
  });

  return { destinations, errors };
}
