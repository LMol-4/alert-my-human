import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readErrorBody, request, truncateBody } from '../src/lib/http';

const options = (extra = {}) => ({ deadline: Date.now() + 5_000, alertId: 'id', ...extra });
const connectError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

for (const status of [429, 500, 503]) {
  test(`retries HTTP ${status} once and releases its body`, async (t) => {
    let cancelled = false;
    const first = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(8192))); },
      cancel() { cancelled = true; },
    }), { status });
    const success = new Response(null, { status: 204 });
    const fetch = t.mock.method(globalThis, 'fetch', async () => fetch.mock.callCount() === 0 ? first : success);
    assert.equal(await request('https://example.test', {}, options()), success);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(cancelled, true);
    assert.equal(fetch.mock.calls[0].arguments[1]?.redirect, 'error');
    assert.notEqual(fetch.mock.calls[0].arguments[1]?.signal, fetch.mock.calls[1].arguments[1]?.signal);
  });
}

test('does not retry permanent failures and hides the body unless asked', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('secret detail', { status: 400 }));
  await assert.rejects(request('https://user:pass@example.test/hook?token=x', {}, options()), (error: Error & Record<string, unknown>) => {
    assert.deepEqual([error.code, error.outcome, error.attempts, error.message], ['HTTP_ERROR', 'rejected', 1, 'HTTP 400']);
    return true;
  });
  await assert.rejects(request('https://example.test', {}, options({ includeErrorBody: true })), { message: 'HTTP 400: secret detail' });
  assert.equal(fetch.mock.callCount(), 2);
});

test('reports the final transient failure after two attempts', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(request('https://example.test', {}, options()), { code: 'HTTP_ERROR', outcome: 'rejected', attempts: 2 });
  assert.equal(fetch.mock.callCount(), 2);
});

test('retries connection failures that happen before sending', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw connectError(); });
  await assert.rejects(request('https://example.test', {}, options()), { code: 'NETWORK', outcome: 'rejected', attempts: 2 });
  assert.equal(fetch.mock.callCount(), 2);
});

for (const [name, error] of [['timeouts', new DOMException('expired', 'TimeoutError')], ['dropped connections', new TypeError('fetch failed')]] as const) {
  test(`does not retry ${name} by default and reports an unknown outcome`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw error; });
    await assert.rejects(request('https://example.test', {}, options()), { outcome: 'unknown', attempts: 1 });
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('retries unknown outcomes when allowed, and stays unknown if the retry is rejected', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (fetch.mock.callCount() === 0) throw new DOMException('expired', 'TimeoutError');
    return new Response(null, { status: 400 });
  });
  await assert.rejects(request('https://example.test', {}, options({ retryUnknown: true })), { code: 'HTTP_ERROR', outcome: 'unknown', attempts: 2 });
});

test('honors Retry-After when it fits the deadline, otherwise returns it', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => fetch.mock.callCount() === 0
    ? Response.json({ parameters: { retry_after: 0.01 } }, { status: 429 })
    : new Response(null, { status: 204 }));
  assert.equal((await request('https://example.test', {}, options())).status, 204);

  fetch.mock.mockImplementation(async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
  await assert.rejects(request('https://example.test', {}, options()), { code: 'RATE_LIMITED', attempts: 1, retryAfterMs: 60_000 });
});

test('respects the deadline and caller cancellation', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(request('https://example.test', {}, options({ deadline: Date.now() - 1 })), { code: 'TIMEOUT', outcome: 'not_attempted', attempts: 0 });
  await assert.rejects(request('https://example.test', {}, options({ signal: AbortSignal.abort() })), { code: 'ABORTED', outcome: 'not_attempted' });
  assert.equal(fetch.mock.callCount(), 0);

  const controller = new AbortController();
  fetch.mock.mockImplementation((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
  const pending = request('https://example.test', {}, options({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED', outcome: 'unknown', attempts: 1 });
});

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

test('normalizes error whitespace', () => {
  assert.equal(truncateBody('  first\n second  '), 'first second');
});
