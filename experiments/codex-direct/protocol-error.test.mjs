import test from 'node:test';
import assert from 'node:assert/strict';

test('an active Codex writer is reported as an occupied conversation, not a broken directory', async () => {
  const api = await import('./app-server.mjs');
  assert.equal(typeof api.protocolError, 'function');
  const error = api.protocolError({ code: -32600, message: 'thread private-id already has an active writer' });
  assert.equal(error.code, 'THREAD_IN_USE');
  assert.doesNotMatch(error.message, /private-id/);
  assert.equal(api.protocolError({ code: -32600, message: 'invalid unrelated request' }).code, 'CODEX_RPC_FAILED');
});
