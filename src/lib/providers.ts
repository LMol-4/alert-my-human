import { checkLength, renderEmail, renderSlack, renderTelegram, renderText } from './render';
import { readId, request } from './http';
import type { Provider } from './types';

// Validate configuration at construction without network calls or echoing values.
function required(provider: string, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${provider}: ${key} is required`);
  }
}

function checkUrl(provider: string, key: string, value: string, protocols = ['https:']) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${provider}: ${key} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw new TypeError(`${provider}: ${key} must use ${protocols.join(' or ')}`);
}

const json = { 'Content-Type': 'application/json' };

export interface EmailConfig {
  /** Resend API key. */
  apiKey: string;
  from: string;
  /** One address, a comma-separated list, or an array. */
  to: string | string[];
}

/** Email through Resend's HTTP API. Forwards idempotency keys to Resend. */
export function email({ apiKey, from, to }: EmailConfig): Provider {
  required('email', { apiKey, from });
  const recipients = (Array.isArray(to) ? to : String(to ?? '').split(',')).map((address) => address.trim()).filter(Boolean);
  if (!recipients.length) throw new TypeError('email: to has no addresses');
  if (![from, ...recipients].every((address) => address.includes('@'))) throw new TypeError('email: addresses must contain @');

  return {
    async send(alert, options) {
      const { subject, html, text } = renderEmail(alert);
      const headers: Record<string, string> = { ...json, Authorization: `Bearer ${apiKey}` };
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      const response = await request(
        'https://api.resend.com/emails',
        { method: 'POST', headers, body: JSON.stringify({ from: `Alert <${from}>`, to: recipients, subject, html, text }) },
        // Resend deduplicates by key, so an uncertain attempt is safe to repeat.
        { ...options, includeErrorBody: true, retryUnknown: Boolean(options.idempotencyKey) },
      );
      return { id: await readId(response, (body: { id?: string }) => body.id) };
    },
  };
}

export interface SlackConfig {
  /** Incoming webhook URL; treat it as a credential. */
  webhookUrl: string;
}

export function slack({ webhookUrl }: SlackConfig): Provider {
  required('slack', { webhookUrl });
  checkUrl('slack', 'webhookUrl', webhookUrl);
  return {
    async send(alert, options) {
      const body = JSON.stringify(renderSlack(alert));
      const response = await request(webhookUrl, { method: 'POST', headers: json, body }, { ...options, includeErrorBody: true });
      await response.body?.cancel();
    },
  };
}

export interface TelegramConfig {
  token: string;
  chatId: string | number;
}

export function telegram({ token, chatId }: TelegramConfig): Provider {
  required('telegram', { token, chatId: chatId === undefined ? undefined : String(chatId) });
  return {
    async send(alert, options) {
      const payload = renderTelegram(alert);
      // Telegram counts the 4096 limit after parsing HTML tags and entities.
      checkLength('Telegram', payload.text.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot);/g, '_'), 4096);
      const response = await request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { method: 'POST', headers: json, body: JSON.stringify({ chat_id: chatId, ...payload }) },
        { ...options, includeErrorBody: true },
      );
      return { id: await readId(response, (body: { result?: { message_id?: number } }) => body.result?.message_id) };
    },
  };
}

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  /** Twilio sender number. */
  from: string;
  /** Recipient in international format, e.g. +353... */
  to: string;
}

/** SMS through Twilio. */
export function sms({ accountSid, authToken, from, to }: SmsConfig): Provider {
  required('sms', { accountSid, authToken, from, to });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return {
    async send(alert, options) {
      const text = renderText(alert);
      checkLength('SMS', text, 1600);
      const response = await request(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, From: from, Body: text }),
        },
        { ...options, includeErrorBody: true },
      );
      return { id: await readId(response, (body: { sid?: string }) => body.sid) };
    },
  };
}

export interface WebhookConfig {
  url: string;
  /** Extra request headers, e.g. { Authorization: 'Bearer ...' }. */
  headers?: Record<string, string>;
}

/**
 * POSTs `{ id, severity, title, message, context? }` as JSON. Redirects are not
 * followed, and errors report only the HTTP status, never the URL or body.
 */
export function webhook({ url, headers }: WebhookConfig): Provider {
  required('webhook', { url });
  checkUrl('webhook', 'url', url, ['https:', 'http:']);
  return {
    async send(alert, options) {
      const extra: Record<string, string> = options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {};
      const response = await request(
        url,
        { method: 'POST', headers: { ...headers, ...extra, ...json }, body: JSON.stringify({ id: options.alertId, ...alert }) },
        options,
      );
      await response.body?.cancel();
    },
  };
}
