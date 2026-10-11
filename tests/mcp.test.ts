import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST } from '../src/app/api/mcp/route';

// mcp-handler starts an unref-less cleanup interval; the test script uses --test-force-exit.
// Auth and channels are read per request.
process.env.AUTH_API_KEY = 'test-key';
process.env.WEBHOOK_URLS = 'https://hook.test';

const rpc = (method: string, params: object = {}, auth = 'Bearer test-key') =>
  POST(new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));

// Streamable HTTP may answer with JSON or a single SSE event.
async function body(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
}

test('unauthorized requests are rejected without outbound sends', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch');
  const response = await rpc('tools/call', { name: 'send_alert', arguments: { channels: ['webhook'], title: 'T', message: 'M' } }, 'Bearer wrong');
  assert.equal(response.status, 401);
  assert.equal(fetch.mock.callCount(), 0);
});

test('initializes, lists tools, and calls send_alert with structured results', async (t) => {
  const init = await body(await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.ok(init.result.serverInfo);

  const tools = await body(await rpc('tools/list'));
  assert.deepEqual(tools.result.tools.map((tool: { name: string }) => tool.name).sort(), ['list_channels', 'send_alert']);

  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const call = await body(await rpc('tools/call', { name: 'send_alert', arguments: { channels: ['webhook'], title: 'T', message: 'M' } }));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.results[0].outcome, 'accepted');
});
