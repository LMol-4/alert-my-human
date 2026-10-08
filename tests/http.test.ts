import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkResponse, fetchWithRetry, readErrorBody, truncateBody, withTimeout } from '../src/app/services/channels/http';

for (const status of [429, 500, 503]) {
  test(`retries HTTP ${status} once and releases its body`, async (t) => {
    let cancelled = false;
    const first = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(8192))); },
      cancel() { cancelled = true; },
    }), { status });
    const success = new Response(null, { status: 204 });
    const fetch = t.mock.method(globalThis, 'fetch', async () => fetch.mock.callCount() === 0 ? first : success);
    assert.equal(await fetchWithRetry('https://example.test', {}), success);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(cancelled, true);
    assert.notEqual(fetch.mock.calls[0].arguments[1]?.signal, fetch.mock.calls[1].arguments[1]?.signal);
  });
}

test('returns permanent failures without retrying', async (t) => {
  const response = new Response('bad request', { status: 400 });
  const fetch = t.mock.method(globalThis, 'fetch', async () => response);
  assert.equal(await fetchWithRetry('https://example.test', {}), response);
  assert.equal(fetch.mock.callCount(), 1);
  await assert.rejects(checkResponse(response), /400 bad request/);
});

test('reports the final transient failure after exactly two attempts', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(fetchWithRetry('https://example.test', {}), /503 unavailable/);
  assert.equal(fetch.mock.callCount(), 2);
});

for (const error of [new TypeError('network failure'), new DOMException('expired', 'TimeoutError')]) {
  test(`retries and normalizes ${error.name}`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw error; });
    await assert.rejects(fetchWithRetry('https://example.test', {}), error.name === 'TimeoutError' ? /timed out after 10s/ : /network failure/);
    assert.equal(fetch.mock.callCount(), 2);
  });
}

test('bounds streamed error reads and cancels the remainder', async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('x'.repeat(1024))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  assert.equal(await readErrorBody(response), 'x'.repeat(200) + '…');
  assert.equal(pulls, 4);
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test('releases successful response bodies without reading them', async () => {
  let cancelled = false;
  await checkResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  assert.equal(cancelled, true);
  await checkResponse(new Response(null, { status: 204 }));
});

test('normalizes error whitespace', () => {
  assert.equal(truncateBody('  first\n second  '), 'first second');
});

test('clears SDK timeout timers on both resolution and rejection', async (t) => {
  const clear = t.mock.method(globalThis, 'clearTimeout');
  assert.equal(await withTimeout(Promise.resolve('sent')), 'sent');
  await assert.rejects(withTimeout(Promise.reject(new Error('failed'))), /failed/);
  assert.equal(clear.mock.callCount(), 2);
  assert.ok(clear.mock.calls.every(call => call.arguments[0] !== undefined));
});

test('bounds an SDK call that never settles', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5), /timed out after 0.005s/);
});
