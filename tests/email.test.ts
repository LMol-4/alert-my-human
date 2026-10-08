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
