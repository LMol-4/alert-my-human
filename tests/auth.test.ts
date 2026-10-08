import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAuthorized } from '../src/app/services/auth';

const request = (header?: string) => new Request('https://example.test/api/mcp', {
  headers: header === undefined ? {} : { authorization: header },
});

test('authentication fails closed without a configured key', () => {
  delete process.env.AUTH_API_KEY;
  assert.equal(isAuthorized(request('Bearer test-key')), false);
});

test('authentication accepts only the exact bearer token', () => {
  process.env.AUTH_API_KEY = 'test-key';
  for (const header of [undefined, 'Bearer wrong-key', 'Bearer bad-keys', 'Basic test-key', 'test-key']) {
    assert.equal(isAuthorized(request(header)), false);
  }
  assert.equal(isAuthorized(request('Bearer test-key')), true);
});
