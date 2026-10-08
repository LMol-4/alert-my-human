import assert from 'node:assert/strict';
import { test } from 'node:test';

test('email is optional when loading and using the channel registry', async () => {
  delete process.env.RESEND_API_KEY;
  const { emailChannel } = await import('../src/app/services/channels/email');
  const { listChannels, sendAlert } = await import('../src/app/services/tools');
  assert.equal(emailChannel.isConfigured(), false);
  assert.ok(listChannels().content[0].text);
  const result = await sendAlert({ channels: ['email'], severity: 'info', title: 'Test', message: 'Body' });
  assert.equal(result.content[0].text, 'Failed: email (not configured).');
});

test('configured email sends the expected payload and reports provider errors', async (t) => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.SENDING_EMAIL = 'sender@example.test';
  process.env.ALERT_EMAIL = ' one@example.test, ,two@example.test ';
  const { emailChannel } = await import('../src/app/services/channels/email');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'test-email' }));
  assert.equal(emailChannel.isConfigured(), true);
  await emailChannel.send({ severity: 'info', title: 'Hello', message: 'Body' });
  const payload = JSON.parse(String(fetch.mock.calls[0].arguments[1]?.body));
  assert.deepEqual(payload.to, ['one@example.test', 'two@example.test']);
  assert.equal(payload.from, 'Alert <sender@example.test>');
  assert.equal(payload.subject, '🔵 Hello');
  assert.equal(payload.text, '[INFO] Hello\nBody');
  assert.ok(payload.html.includes('Body'));
  fetch.mock.mockImplementation(async () => Response.json({ name: 'validation_error', message: 'invalid recipient' }, { status: 422 }));
  await assert.rejects(emailChannel.send({ severity: 'info', title: 'Hello', message: 'Body' }), /invalid recipient/);
});
