import assert from 'node:assert/strict';
import test from 'node:test';

test('daily configuration fixes loopback binding and enables SDK connection recovery without a default agent', async () => {
  const { validateRuntimeConfig } = await import('../bridge/runtime-config.mjs');
  const config = validateRuntimeConfig({ port: 7467, apiToken: 'a'.repeat(64) }, { daily: true });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.allowUnselected, true);
  assert.deepEqual(config.client.reconnect, { enabled: true, baseDelayMs: 1000, maxDelayMs: 30000 });
  assert.equal(config.client.url, 'ws://127.0.0.1:6767/ws');
});

test('unsafe listener, nonlocal Paseo URLs, weak tokens and partial targets are rejected before connecting', async () => {
  const { validateRuntimeConfig } = await import('../bridge/runtime-config.mjs');
  const base = { port: 7467, apiToken: 'a'.repeat(64) };
  for (const extra of [
    { host: '0.0.0.0' }, { port: 80 }, { apiToken: 'short' },
    { paseoUrl: 'ws://example.invalid/ws' }, { paseoUrl: 'ws://user:pass@localhost:6767/ws' },
    { agentId: 'a1' },
  ]) assert.throws(() => validateRuntimeConfig({ ...base, ...extra }, { daily: true }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateRuntimeConfig(base), { code: 'CONFIG_INVALID' });
});

test('daily startup ignores target identities inherited from the development agent environment', async () => {
  const { resolveRuntimeConfig } = await import('../bridge/runtime-config.mjs');
  const config = resolveRuntimeConfig({ port: 7467, apiToken: 'a'.repeat(64) }, {
    daily: true, env: { PASEO_AGENT_ID: 'current-developer', PASEO_URL: 'ws://unrelated.invalid/ws' },
  });
  assert.equal(config.agentId, undefined);
  assert.equal(config.workspaceId, undefined);
  assert.equal(config.client.url, 'ws://127.0.0.1:6767/ws');
});
