import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlerter } from '../src/lib/alerter';
import { DeliveryError, type Provider } from '../src/lib/types';

const alert = { title: 'Test', message: 'Body' };
const fake = (send: Provider['send'] = async () => ({ id: 'p-1' })) => {
  const calls: Parameters<Provider['send']>[] = [];
  return { calls, send: (...args: Parameters<Provider['send']>) => { calls.push(args); return send(...args); } };
};
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((r) => { resolve = r; }), resolve };
};

test('reports per-destination outcomes for mixed results, concurrently and deduplicated', async () => {
  const gate = deferred();
  const ok = fake(async () => { await gate.promise; return { id: 'm-1' }; });
  const rejected = fake(async () => { throw new DeliveryError('HTTP_ERROR', 'HTTP 400'); });
  const unknown = fake(async () => { throw new DeliveryError('TIMEOUT', 'No response', 'unknown'); });
  const buggy = fake(async () => { throw new Error('https://secret.example'); });
  const alerts = createAlerter({ destinations: { ok, rejected, unknown, buggy } });

  const pending = alerts.send({ ...alert, destinations: ['ok', 'ok', 'rejected', 'unknown', 'buggy', 'missing'], idempotencyKey: 'k' });
  await new Promise((r) => setImmediate(r));
  assert.equal(rejected.calls.length, 1); // started while `ok` is still pending
  gate.resolve();
  const { id, results } = await pending;

  assert.equal(ok.calls.length, 1);
  assert.deepEqual(ok.calls[0][0], { ...alert, severity: 'info' });
  assert.equal(ok.calls[0][1].idempotencyKey, 'k:ok');
  assert.equal(ok.calls[0][1].alertId, id);
  assert.deepEqual(results.map((r) => [r.destination, r.outcome, r.error?.code, r.providerId]), [
    ['ok', 'accepted', undefined, 'm-1'],
    ['rejected', 'rejected', 'HTTP_ERROR', undefined],
    ['unknown', 'unknown', 'TIMEOUT', undefined],
    ['buggy', 'unknown', 'PROVIDER_ERROR', undefined],
    ['missing', 'not_attempted', 'UNKNOWN_DESTINATION', undefined],
  ]);
  assert.ok(!JSON.stringify(results).includes('secret'));
});

test('invalid input throws before any send', async () => {
  const provider = fake();
  const alerts = createAlerter({ destinations: { a: provider } });
  await assert.rejects(alerts.send({ title: '', message: 'Body', destinations: ['a'] }), TypeError);
  await assert.rejects(alerts.send({ ...alert, destinations: [] }), TypeError);
  assert.equal(provider.calls.length, 0);
  assert.throws(() => createAlerter({ destinations: { a: {} as Provider } }), TypeError);
});

test('instances keep isolated destinations and state', async () => {
  const a = createAlerter({ destinations: { phone: fake() }, history: 5 });
  const b = createAlerter({ destinations: { team: fake() }, history: 5 });
  await a.send({ ...alert, destinations: ['phone'] });
  assert.deepEqual([a.destinations, b.destinations], [['phone'], ['team']]);
  assert.equal(a.recent().length, 1);
  assert.equal(b.recent().length, 0);
});

test('history is bounded and onResult failures do not change outcomes', async () => {
  const alerts = createAlerter({ destinations: { a: fake() }, history: 2, onResult: () => { throw new Error('logger down'); } });
  for (let i = 0; i < 3; i++) {
    const { results } = await alerts.send({ ...alert, message: `m${i}`, destinations: ['a'] });
    assert.equal(results[0].outcome, 'accepted');
  }
  assert.equal(alerts.recent().length, 2);
  assert.ok(!JSON.stringify(alerts.recent()).includes('m2'));
});

test('dedupe shares in-flight sends and suppresses recent accepted repeats', async () => {
  const gate = deferred();
  const provider = fake(async () => { await gate.promise; return { id: 'p' }; });
  const alerts = createAlerter({ destinations: { a: provider }, dedupe: { ttlMs: 60_000 } });
  const first = alerts.send({ ...alert, destinations: ['a'] });
  const second = alerts.send({ ...alert, destinations: ['a'] });
  const different = alerts.send({ ...alert, message: 'Other', destinations: ['a'] });
  gate.resolve();
  const [r1, r2, r3] = (await Promise.all([first, second, different])).map((s) => s.results[0]);
  assert.equal(provider.calls.length, 2);
  assert.deepEqual([r1.outcome, r1.reused], ['accepted', undefined]);
  assert.deepEqual([r2.outcome, r2.reused], ['accepted', 'in-flight']);
  assert.equal(r3.outcome, 'accepted');

  const repeat = (await alerts.send({ ...alert, destinations: ['a'] })).results[0];
  assert.deepEqual([repeat.outcome, repeat.error?.code, repeat.attempts], ['suppressed', 'DUPLICATE', 0]);
  assert.ok(repeat.retryAfterMs! > 0);
  assert.equal(provider.calls.length, 2);
});

test('dedupe does not remember rejected or unknown sends, and expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let outcome: 'rejected' | 'unknown' | 'accepted' = 'rejected';
  const provider = fake(async () => {
    if (outcome !== 'accepted') throw new DeliveryError('HTTP_ERROR', 'failed', outcome);
  });
  const alerts = createAlerter({ destinations: { a: provider }, dedupe: { ttlMs: 1000 } });
  const send = async () => (await alerts.send({ ...alert, destinations: ['a'] })).results[0].outcome;
  assert.equal(await send(), 'rejected');
  outcome = 'unknown';
  assert.equal(await send(), 'unknown');
  outcome = 'accepted';
  assert.equal(await send(), 'accepted');
  assert.equal(await send(), 'suppressed');
  t.mock.timers.tick(1000);
  assert.equal(await send(), 'accepted');
  assert.equal(provider.calls.length, 4);
});

test('dedupe is bounded: finished entries are evicted, in-flight ones are not', async () => {
  const gate = deferred();
  const alerts = createAlerter({ destinations: { a: fake(async () => { await gate.promise; }) }, dedupe: { ttlMs: 60_000, maxEntries: 1 } });
  const inFlight = alerts.send({ ...alert, destinations: ['a'] });
  const overflow = (await alerts.send({ ...alert, message: 'Other', destinations: ['a'] })).results[0];
  assert.deepEqual([overflow.outcome, overflow.error?.code], ['not_attempted', 'OVERLOADED']);
  gate.resolve();
  await inFlight;
  // The accepted entry is evicted to make room, so a new alert still sends.
  assert.equal((await alerts.send({ ...alert, message: 'Other', destinations: ['a'] })).results[0].outcome, 'accepted');
});

test('local rate limits suppress sends per destination within a window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const alerts = createAlerter({ destinations: { a: fake(), b: fake() }, rateLimit: { limit: 1, windowMs: 1000 } });
  const outcomes = async (destinations: string[]) => (await alerts.send({ ...alert, destinations })).results.map((r) => r.outcome);
  assert.deepEqual(await outcomes(['a']), ['accepted']);
  const [limited] = (await alerts.send({ ...alert, destinations: ['a'] })).results;
  assert.deepEqual([limited.outcome, limited.error?.code, limited.retryAfterMs], ['suppressed', 'LOCAL_RATE_LIMIT', 1000]);
  assert.deepEqual(await outcomes(['b']), ['accepted']);
  t.mock.timers.tick(1000);
  assert.deepEqual(await outcomes(['a']), ['accepted']);
});

test('concurrency limits queue sends and reject overflow', async () => {
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const provider = fake(async () => { peak = Math.max(peak, ++active); await gate.promise; active--; });
  const alerts = createAlerter({ destinations: { a: provider }, concurrency: { max: 1, maxQueued: 1 } });
  const sends = [1, 2, 3].map((i) => alerts.send({ ...alert, message: `m${i}`, destinations: ['a'] }));
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  const outcomes = (await Promise.all(sends)).map((s) => s.results[0].error?.code ?? s.results[0].outcome);
  assert.deepEqual(outcomes, ['accepted', 'accepted', 'OVERLOADED']);
  assert.equal(peak, 1);
  assert.equal((await alerts.send({ ...alert, destinations: ['a'] })).results[0].outcome, 'accepted');
});

test('passes the deadline and caller signal to providers', async () => {
  const provider = fake();
  const controller = new AbortController();
  const before = Date.now();
  await createAlerter({ destinations: { a: provider }, deadlineMs: 1000 }).send({ ...alert, destinations: ['a'], signal: controller.signal });
  const { deadline, signal } = provider.calls[0][1];
  assert.ok(deadline >= before + 1000 && deadline <= Date.now() + 1000);
  assert.equal(signal, controller.signal);
});
