import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEmail, renderSlack, renderTelegram, renderText, validateAlert } from '../src/lib/render';
import type { Severity } from '../src/lib/types';

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

type Blocks = Array<{ text?: { text: string }; fields?: Array<{ text: string }> }>;
const contextOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`<key${i}>`, '<&>']));

test('Slack escapes reserved markup and uses fields for up to ten context entries', () => {
  const blocks = renderSlack({ ...alert, context: contextOf(10) }).attachments[0].blocks as Blocks;
  assert.ok(blocks[0].text?.text.includes('&lt;title &amp; "quote"&gt;'));
  assert.equal(blocks[1].fields?.length, 10);
  assert.equal(blocks[1].fields?.[0].text, '*&lt;key0&gt;*\n&lt;&amp;&gt;');
});

test('Slack keeps every context entry beyond ten in one text block', () => {
  const blocks = renderSlack({ ...alert, context: contextOf(12) }).attachments[0].blocks as Blocks;
  assert.equal(blocks[1].fields, undefined);
  assert.equal(blocks[1].text?.text.split('\n').length, 12);
  assert.ok(blocks[1].text?.text.includes('*&lt;key11&gt;:* &lt;&amp;&gt;'));
});

test('Slack rejects an oversized section before sending', () => {
  assert.throws(() => renderSlack({ ...alert, message: 'x'.repeat(3000) }), { code: 'INVALID_PAYLOAD', outcome: 'not_attempted' });
});

test('validation defaults severity and rejects empty, oversized, or malformed input', () => {
  assert.deepEqual(validateAlert({ title: 'T', message: 'M' }), { title: 'T', message: 'M', severity: 'info' });
  for (const bad of [
    { title: ' ', message: 'M' },
    { title: 'T', message: 'x'.repeat(4001) },
    { title: 'T', message: 'M', severity: 'loud' },
    { title: 'T', message: 'M', context: contextOf(21) },
    { title: 'T', message: 'M', context: { key: 5 } },
  ]) {
    assert.throws(() => validateAlert(bad as never), TypeError);
  }
});

for (const severity of ['info', 'success', 'warning', 'error'] as Severity[]) {
  test(`renders ${severity} without optional context`, () => {
    const input = { severity, title: 'Title', message: 'Body' };
    assert.equal(renderText(input), `[${severity.toUpperCase()}] Title\nBody`);
    assert.ok(renderEmail(input).html.includes('Body'));
    assert.equal(renderSlack(input).attachments[0].blocks.length, 1);
    assert.ok(renderTelegram(input).text.endsWith('Body'));
  });
}
