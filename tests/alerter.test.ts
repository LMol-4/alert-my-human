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

test('instances keep isolated destinations', async () => {
  const a = createAlerter({ destinations: { phone: fake() } });
  const b = createAlerter({ destinations: { team: fake() } });
  assert.deepEqual([a.destinations, b.destinations], [['phone'], ['team']]);
  assert.equal((await b.send({ ...alert, destinations: ['phone'] })).results[0].error?.code, 'UNKNOWN_DESTINATION');
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
