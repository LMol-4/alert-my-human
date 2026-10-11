import assert from 'node:assert/strict';
import { test } from 'node:test';
import { email, slack, sms, telegram, webhook } from '../src/lib/providers';

const alert = { severity: 'info' as const, title: 'Hello', message: 'Body' };
const options = (extra = {}) => ({ deadline: Date.now() + 5_000, alertId: 'alert-1', ...extra });
type Init = RequestInit & { headers: Record<string, string> };
const call = (fetch: { mock: { calls: Array<{ arguments: unknown[] }> } }, i = 0) =>
  ({ url: String(fetch.mock.calls[i].arguments[0]), init: fetch.mock.calls[i].arguments[1] as Init });

test('configuration is validated at construction without echoing secret values', () => {
  const cases: Array<[() => unknown, RegExp]> = [
    [() => email({ apiKey: '', from: 'a@b.test', to: 'c@d.test' }), /email: apiKey is required/],
    [() => email({ apiKey: 're_secret', from: 'a@b.test', to: ' , ' }), /email: to has no addresses/],
    [() => slack({ webhookUrl: 'http://hooks.example/secret' }), /slack: webhookUrl must use https:/],
    [() => telegram({ token: 'secret', chatId: '' }), /telegram: chatId is required/],
    [() => sms({ accountSid: 'AC1', authToken: 'secret', from: '+1', to: '' }), /sms: to is required/],
    [() => webhook({ url: 'not a url secret' }), /webhook: url is not a valid URL/],
  ];
  for (const [build, message] of cases) {
    assert.throws(build, (error: Error) => message.test(error.message) && !/secret/.test(error.message));
  }
});

test('email posts to Resend, forwards idempotency keys, and returns the provider ID', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'email-1' }));
  const provider = email({ apiKey: 're_key', from: 'sender@example.test', to: ' one@example.test, ,two@example.test ' });
  assert.deepEqual(await provider.send(alert, options({ idempotencyKey: 'k:email' })), { id: 'email-1' });
  const { url, init } = call(fetch);
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.headers.Authorization, 'Bearer re_key');
  assert.equal(init.headers['Idempotency-Key'], 'k:email');
  const payload = JSON.parse(String(init.body));
  assert.deepEqual(payload.to, ['one@example.test', 'two@example.test']);
  assert.equal(payload.from, 'Alert <sender@example.test>');
  assert.equal(payload.subject, '🔵 Hello');
  assert.equal(payload.text, '[INFO] Hello\nBody');

  fetch.mock.mockImplementation(async () => Response.json({ message: 'invalid recipient' }, { status: 422 }));
  await assert.rejects(provider.send(alert, options()), { code: 'HTTP_ERROR', message: /422: .*invalid recipient/ });
});

test('email retries a timeout only when an idempotency key makes it safe', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (fetch.mock.callCount() === 0) throw new DOMException('expired', 'TimeoutError');
    return Response.json({ id: 'email-2' });
  });
  const provider = email({ apiKey: 're_key', from: 'a@example.test', to: 'b@example.test' });
  assert.deepEqual(await provider.send(alert, options({ idempotencyKey: 'k' })), { id: 'email-2' });
  assert.equal(call(fetch, 0).init.headers['Idempotency-Key'], call(fetch, 1).init.headers['Idempotency-Key']);
});

test('Slack posts the rendered payload and releases the response', async (t) => {
  let cancelled = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await slack({ webhookUrl: 'https://hooks.slack.test/T/B/secret' }).send(alert, options());
  assert.equal(JSON.parse(String(call(fetch).init.body)).text, '🔵 Hello');
  assert.equal(cancelled, true);
});

test('Telegram returns the message ID, checks length, and never exposes the token', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, result: { message_id: 42 } }));
  const provider = telegram({ token: 'bot-secret', chatId: 123 });
  assert.deepEqual(await provider.send(alert, options()), { id: '42' });
  assert.equal(JSON.parse(String(call(fetch).init.body)).chat_id, 123);

  await assert.rejects(provider.send({ ...alert, message: '<'.repeat(4000), context: { k: 'x'.repeat(100) } }, options()), { code: 'INVALID_PAYLOAD' });
  // Escaped characters count once after Telegram parses entities.
  await provider.send({ ...alert, message: '<'.repeat(4000) }, options());

  fetch.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(provider.send(alert, options()), (error: Error) => !error.message.includes('bot-secret'));
});

test('SMS posts form data to Twilio and rejects texts over 1600 characters', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ sid: 'SM1' }, { status: 201 }));
  const provider = sms({ accountSid: 'AC1', authToken: 'token', from: '+10000000000', to: '+353000000' });
  assert.deepEqual(await provider.send(alert, options()), { id: 'SM1' });
  const { url, init } = call(fetch);
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from('AC1:token').toString('base64')}`);
  assert.equal(new URLSearchParams(String(init.body)).get('To'), '+353000000');
  await assert.rejects(provider.send({ ...alert, message: 'x'.repeat(1600) }, options()), { code: 'INVALID_PAYLOAD' });
  assert.equal(fetch.mock.callCount(), 1);
});

test('webhooks send the documented JSON shape and headers, and errors omit the URL', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const provider = webhook({ url: 'https://example.test/hook?token=secret', headers: { Authorization: 'Bearer s' } });
  await provider.send({ ...alert, context: { job: 'export' } }, options({ idempotencyKey: 'k:hook' }));
  const { init } = call(fetch);
  assert.deepEqual(JSON.parse(String(init.body)), { id: 'alert-1', ...alert, context: { job: 'export' } });
  assert.equal(init.headers.Authorization, 'Bearer s');
  assert.equal(init.headers['Idempotency-Key'], 'k:hook');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.redirect, 'error');

  fetch.mock.mockImplementation(async () => new Response('token=secret', { status: 403 }));
  await assert.rejects(provider.send(alert, options()), { message: 'HTTP 403' });
});
