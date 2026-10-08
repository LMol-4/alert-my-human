import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNELS } from '../src/app/services/channels';
import { listChannels, sendAlert } from '../src/app/services/tools';

const alert = { severity: 'warning' as const, title: 'Test', message: 'Body', context: { job: 'test' } };

test('lists only configured channels', (t) => {
  for (const channel of CHANNELS) t.mock.method(channel, 'isConfigured', () => channel.name === 'slack');
  assert.equal(listChannels().content[0].text, 'Configured channels: slack.');
});

test('reports mixed outcomes, deduplicates requests, and starts deliveries concurrently', async (t) => {
  let finishEmail!: () => void;
  for (const channel of CHANNELS) {
    t.mock.method(channel, 'isConfigured', () => ['email', 'slack'].includes(channel.name));
    t.mock.method(channel, 'send', async () => { throw new Error('unexpected delivery'); });
  }
  const email = t.mock.method(CHANNELS[0], 'send', () => new Promise<void>(resolve => { finishEmail = resolve; }));
  const slack = t.mock.method(CHANNELS[1], 'send', async () => { throw new Error('provider rejected'); });
  const pending = sendAlert({ ...alert, channels: ['email', 'email', 'slack', 'sms', 'unknown', 'unknown'] });
  assert.equal(email.mock.callCount(), 1);
  assert.equal(slack.mock.callCount(), 1);
  assert.deepEqual(email.mock.calls[0].arguments[0], alert);
  finishEmail();
  const result = await pending;
  assert.equal(result.content[0].text, 'Sent via: email. Failed: slack (provider rejected), sms (not configured), unknown (unknown channel).');
});

test('handles non-Error channel rejections', async (t) => {
  t.mock.method(CHANNELS[1], 'isConfigured', () => true);
  t.mock.method(CHANNELS[1], 'send', () => Promise.reject('offline'));
  const result = await sendAlert({ ...alert, channels: ['slack'] });
  assert.equal(result.content[0].text, 'Failed: slack (offline).');
});
