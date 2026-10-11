import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { listChannels, sendAlert } from '../src/app/services/tools';

const alert = { severity: 'warning' as const, title: 'Test', message: 'Body' };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(RESEND|SENDING|ALERT|SLACK|TELEGRAM|TWILIO|WEBHOOK)_/.test(key)) delete process.env[key];
  }
});

test('lists configured and misconfigured channels', () => {
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
  process.env.TELEGRAM_BOT_TOKEN = 'secret';
  const result = listChannels();
  assert.equal(result.content[0].text, 'Configured channels: slack.\nMisconfigured: telegram: missing TELEGRAM_CHAT_ID.');
  assert.deepEqual(result.structuredContent, { channels: ['slack'], errors: ['telegram: missing TELEGRAM_CHAT_ID'] });
});

test('partial success is not an MCP error and reports each destination', async (t) => {
  process.env.WEBHOOK_URLS = 'good=https://good.test,bad=https://bad.test?token=secret';
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(null, { status: url.includes('bad') ? 400 : 204 }));
  const result = await sendAlert({ ...alert, channels: ['good', 'bad', 'email'] });
  assert.equal(result.isError, false);
  assert.equal(
    result.content[0].text,
    'Accepted: good. Rejected: bad (HTTP_ERROR: HTTP 400). Not attempted: email (UNKNOWN_DESTINATION: Unknown destination).',
  );
  assert.deepEqual(result.structuredContent?.results.map((r) => r.outcome), ['accepted', 'rejected', 'not_attempted']);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('complete failure and invalid input set isError', async (t) => {
  process.env.WEBHOOK_URLS = 'https://down.test';
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('expired', 'TimeoutError'); });
  const failed = await sendAlert({ ...alert, channels: ['webhook'] });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /^Unknown outcome \(may have been delivered\): webhook \(TIMEOUT: /);

  const invalid = await sendAlert({ ...alert, title: ' ', channels: ['webhook'] });
  assert.deepEqual(invalid, { content: [{ type: 'text', text: 'Invalid alert: title must be a non-empty string' }], isError: true });
});
