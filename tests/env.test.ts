import assert from 'node:assert/strict';
import { test } from 'node:test';
import { destinationsFromEnv } from '../src/lib/env';

test('skips unset channels and builds fully configured ones', () => {
  const { destinations, errors } = destinationsFromEnv({
    SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
    TELEGRAM_BOT_TOKEN: ' ',
    TELEGRAM_CHAT_ID: '',
  });
  assert.deepEqual(Object.keys(destinations), ['slack']);
  assert.deepEqual(errors, []);
});

test('reports partial or invalid channels by variable name without values', () => {
  const { destinations, errors } = destinationsFromEnv({
    RESEND_API_KEY: 're_secret',
    SENDING_EMAIL: 'a@example.test',
    ALERT_EMAIL: ' , ',
    TWILIO_AUTH_TOKEN: 'secret',
  });
  assert.deepEqual(Object.keys(destinations), []);
  assert.deepEqual(errors, [
    'email: to has no addresses',
    'sms: missing TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, ALERT_PHONE_NUMBER',
  ]);
});

test('webhook URLs become one destination each, optionally named', async (t) => {
  assert.deepEqual(Object.keys(destinationsFromEnv({ WEBHOOK_URLS: ' https://one.test ' }).destinations), ['webhook']);
  assert.deepEqual(Object.keys(destinationsFromEnv({ WEBHOOK_URLS: 'https://one.test?a=b,,https://two.test' }).destinations), ['webhook-1', 'webhook-2']);

  const { destinations, errors } = destinationsFromEnv({
    WEBHOOK_URLS: 'home=https://home.test,ci=https://ci.test,home=https://again.test,bad=ftp://x',
    WEBHOOK_SECRET: 'shh',
  });
  assert.deepEqual(Object.keys(destinations), ['home', 'ci']);
  assert.deepEqual(errors, ['WEBHOOK_URLS: duplicate name home', 'webhook: url must use https: or http:']);

  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await destinations.ci.send({ severity: 'info', title: 'T', message: 'M' }, { deadline: Date.now() + 1000, alertId: 'id' });
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://ci.test');
  assert.equal((fetch.mock.calls[0].arguments[1]?.headers as Record<string, string>).Authorization, 'Bearer shh');
});
