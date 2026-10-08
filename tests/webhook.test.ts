import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webhookChannel } from '../src/app/services/channels/webhook';

const alert = { severity: 'info' as const, title: 'Test', message: 'Body' };

test('blank URL lists are unconfigured and cannot report delivery success', async (t) => {
  process.env.WEBHOOK_URLS = ' , , ';
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  assert.equal(webhookChannel.isConfigured(), false);
  await assert.rejects(webhookChannel.send(alert), /No webhook URLs configured/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('webhooks fan out concurrently using one serialized payload and release responses', async (t) => {
  process.env.WEBHOOK_URLS = ' https://one.test , , https://two.test ';
  let serializations = 0;
  let cancelled = 0;
  const payload = { ...alert, toJSON() { serializations++; return alert; } };
  const resolvers: Array<(response: Response) => void> = [];
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => resolvers.push(resolve)));
  const sending = webhookChannel.send(payload);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(serializations, 1);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0]), ['https://one.test', 'https://two.test']);
  for (const resolve of resolvers) resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await sending;
  assert.equal(cancelled, 2);
  for (const call of fetch.mock.calls) assert.deepEqual(JSON.parse(String(call.arguments[1]?.body)), alert);
});

test('a failed webhook does not prevent delivery to other destinations', async (t) => {
  process.env.WEBHOOK_URLS = 'https://bad.test,https://good.test';
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => new Response(null, { status: String(url).includes('bad') ? 400 : 204 }));
  await assert.rejects(webhookChannel.send(alert), { message: 'https://bad.test → 400' });
  assert.equal(fetch.mock.callCount(), 2);
});
