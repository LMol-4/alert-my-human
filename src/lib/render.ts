import { DeliveryError, type Alert, type Severity, type ValidAlert } from './types';

export const LIMITS = { title: 250, message: 4000, contextEntries: 20, contextKey: 64, contextValue: 500 };

const SEVERITIES: Severity[] = ['info', 'success', 'warning', 'error'];

/** Shared input validation for the library and MCP entry points. Throws TypeError. */
export function validateAlert({ title, message, severity = 'info', context }: Alert): ValidAlert {
  const text = (name: string, value: unknown, max: number) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
    if (value.length > max) throw new TypeError(`${name} must be at most ${max} characters`);
  };
  text('title', title, LIMITS.title);
  text('message', message, LIMITS.message);
  if (!SEVERITIES.includes(severity)) throw new TypeError(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (context !== undefined) {
    if (typeof context !== 'object' || context === null) throw new TypeError('context must be an object of strings');
    const entries = Object.entries(context);
    if (entries.length > LIMITS.contextEntries) throw new TypeError(`context allows at most ${LIMITS.contextEntries} entries`);
    for (const [key, value] of entries) {
      text('context key', key, LIMITS.contextKey);
      if (typeof value !== 'string' || value.length > LIMITS.contextValue) {
        throw new TypeError(`context values must be strings of at most ${LIMITS.contextValue} characters`);
      }
    }
  }
  return { title, message, severity, ...(context && { context }) };
}

// Final rendered-size check; limits are in UTF-16 units, matching JavaScript string length.
export function checkLength(provider: string, text: string, max: number) {
  if (text.length > max) {
    throw new DeliveryError('INVALID_PAYLOAD', `${provider} message is ${text.length} characters; the limit is ${max}`, 'not_attempted', 0);
  }
}

export const SEVERITY_META: Record<Severity, { emoji: string; color: string; label: string }> = {
  info: { emoji: '🔵', color: '#2563eb', label: 'Info' },
  success: { emoji: '🟢', color: '#16a34a', label: 'Success' },
  warning: { emoji: '🟡', color: '#d97706', label: 'Warning' },
  error: { emoji: '🔴', color: '#dc2626', label: 'Error' },
};

const contextEntries = (context?: Record<string, string>) => Object.entries(context ?? {});

// Escape for HTML contexts (email body, Telegram HTML parse mode).
function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape the three characters Slack reserves in mrkdwn text.
function escapeSlack(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain text — used by SMS and as the email/Slack notification fallback.
export function renderText({ severity, title, message, context }: ValidAlert) {
  const { label } = SEVERITY_META[severity];
  const context_ = contextEntries(context)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return [`[${label.toUpperCase()}] ${title}`, '', message, context_ ? `\n${context_}` : '']
    .filter(Boolean)
    .join('\n');
}

// HTML email with a severity-coloured header bar.
export function renderEmail(alert: ValidAlert) {
  const { emoji, color, label } = SEVERITY_META[alert.severity];
  const subject = `${emoji} ${alert.title}`;
  const entries = contextEntries(alert.context);

  const contextHtml = entries.length
    ? `<table style="width:100%;border-collapse:collapse;margin-top:16px;">
        ${entries
          .map(
            ([key, value]) => `<tr>
              <td style="padding:4px 12px 4px 0;color:#666;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(key)}</td>
              <td style="padding:4px 0;color:#333;font-size:13px;">${escapeHtml(value)}</td>
            </tr>`,
          )
          .join('')}
      </table>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f5f5f5;">
  <div style="max-width:560px;margin:40px auto;background-color:#fff;border-radius:8px;overflow:hidden;border:1px solid #eee;">
    <div style="padding:16px 24px;border-left:4px solid ${color};background-color:#fafafa;">
      <span style="font-size:12px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${color};">${label}</span>
    </div>
    <div style="padding:24px;">
      <h1 style="margin:0 0 12px 0;font-size:20px;color:#111;">${escapeHtml(alert.title)}</h1>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#333;white-space:pre-wrap;">${escapeHtml(alert.message)}</p>
      ${contextHtml}
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text: renderText(alert) };
}

const SLACK_SECTION_MAX = 3000;

// Slack incoming-webhook payload: blocks wrapped in a colour-barred attachment.
export function renderSlack(alert: ValidAlert) {
  const { emoji, color } = SEVERITY_META[alert.severity];
  const entries = contextEntries(alert.context);

  const text = `*${emoji} ${escapeSlack(alert.title)}*\n${escapeSlack(alert.message)}`;
  checkLength('Slack', text, SLACK_SECTION_MAX);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  // Slack allows at most ten fields per section; longer context becomes one text block.
  if (entries.length > 10) {
    const text = entries.map(([key, value]) => `*${escapeSlack(key)}:* ${escapeSlack(value)}`).join('\n');
    checkLength('Slack context', text, SLACK_SECTION_MAX);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  } else if (entries.length) {
    blocks.push({
      type: 'section',
      fields: entries.map(([key, value]) => ({
        type: 'mrkdwn',
        text: `*${escapeSlack(key)}*\n${escapeSlack(value)}`,
      })),
    });
  }

  return { text: `${emoji} ${alert.title}`, attachments: [{ color, blocks }] };
}

// Telegram sendMessage payload (minus chat_id) using HTML parse mode.
export function renderTelegram(alert: ValidAlert) {
  const { emoji } = SEVERITY_META[alert.severity];
  const lines = [`${emoji} <b>${escapeHtml(alert.title)}</b>`, '', escapeHtml(alert.message)];
  const entries = contextEntries(alert.context);
  if (entries.length) {
    lines.push('');
    for (const [key, value] of entries) lines.push(`<b>${escapeHtml(key)}:</b> ${escapeHtml(value)}`);
  }
  return { text: lines.join('\n'), parse_mode: 'HTML' as const };
}
