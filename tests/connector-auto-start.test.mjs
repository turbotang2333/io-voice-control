import test from 'node:test';
import assert from 'node:assert/strict';
import { autoStartConfiguredConnection } from '../distribution/auto-start.mjs';

test('login startup reconnects only an already configured secure connection', async () => {
  const calls = [];
  const actions = { async status() { return { phase: 'configured', connectionMode: 'secure' }; },
    async connect() { calls.push('connect'); return { starting: true }; } };
  assert.deepEqual(await autoStartConfiguredConnection(actions), { attempted: true });
  assert.deepEqual(calls, ['connect']);
});

test('login startup leaves new, legacy and damaged configurations untouched', async () => {
  for (const status of [{ phase: 'new' }, { phase: 'existing', connectionMode: 'legacy' },
    { phase: 'configured', connectionMode: 'secure', secureError: 'SECURE_CONFIGURATION_INVALID' }]) {
    let called = false;
    const result = await autoStartConfiguredConnection({ async status() { return status; }, async connect() { called = true; } });
    assert.deepEqual(result, { attempted: false }); assert.equal(called, false);
  }
});

test('an unavailable connection does not prevent the status page from opening', async () => {
  const actions = { async status() { return { phase: 'configured', connectionMode: 'secure' }; },
    async connect() { throw Object.assign(Error(), { code: 'SECURE_START_FAILED' }); } };
  assert.deepEqual(await autoStartConfiguredConnection(actions), { attempted: true, error: 'SECURE_START_FAILED' });
});
