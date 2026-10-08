import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEmail, renderSlack, renderTelegram, renderText, type AlertSeverity } from '../src/app/services/alert';

const alert = { severity: 'error' as const, title: '<title & "quote">', message: '<message & "quote">', context: { '<key>': '<value & "quote">' } };

test('email and Telegram escape user-controlled HTML including context', () => {
  for (const rendered of [renderEmail(alert).html, renderTelegram(alert).text]) {
    assert.ok(rendered.includes('&lt;title &amp; &quot;quote&quot;&gt;'));
    assert.ok(rendered.includes('&lt;message &amp; &quot;quote&quot;&gt;'));
    assert.ok(rendered.includes('&lt;key&gt;'));
    assert.ok(rendered.includes('&lt;value &amp; &quot;quote&quot;&gt;'));
    assert.ok(!rendered.includes('<title'));
  }
  assert.equal(renderEmail(alert).text, renderText(alert));
  assert.equal(renderTelegram(alert).parse_mode, 'HTML');
});

test('Slack escapes reserved markup and caps context fields at ten', () => {
  const payload = renderSlack({ ...alert, context: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`<key${i}>`, '<&>'])) });
  const blocks = payload.attachments[0].blocks as Array<{ text?: { text: string }; fields?: Array<{ text: string }> }>;
  assert.ok(blocks[0].text?.text.includes('&lt;title &amp; "quote"&gt;'));
  assert.equal(blocks[1].fields?.length, 10);
  assert.equal(blocks[1].fields?.[0].text, '*&lt;key0&gt;*\n&lt;&amp;&gt;');
});

for (const severity of ['info', 'success', 'warning', 'error'] as AlertSeverity[]) {
  test(`renders ${severity} without optional context`, () => {
    const input = { severity, title: 'Title', message: 'Body' };
    assert.equal(renderText(input), `[${severity.toUpperCase()}] Title\nBody`);
    assert.ok(renderEmail(input).html.includes('Body'));
    assert.equal(renderSlack(input).attachments[0].blocks.length, 1);
    assert.ok(renderTelegram(input).text.endsWith('Body'));
  });
}
