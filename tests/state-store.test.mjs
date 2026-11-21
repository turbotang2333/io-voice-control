import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('invalid persisted state fails closed instead of silently falling back to the default agent', async t => {
  const { createStateStore } = await import('../bridge/state-store.mjs');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  for (const value of ['{', '{"version":99}', '{"version":1,"selection":{},"requests":{}}']) {
    writeFileSync(path, value);
    assert.throws(() => createStateStore(path), { code: 'STATE_INVALID' });
  }
});

test('a request reserved before an interrupted task survives restart and cannot be reassigned', async t => {
  const { createStateStore } = await import('../bridge/state-store.mjs');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  createStateStore(path).reserveRequest('r1', { hash: 'a'.repeat(64), workspaceId: 'w1', agentId: 'a1' });
  const restored = createStateStore(path);
  assert.deepEqual(restored.findRequest('r1'), { hash: 'a'.repeat(64), workspaceId: 'w1', agentId: 'a1' });
  assert.throws(() => restored.reserveRequest('r1', { hash: 'b'.repeat(64), workspaceId: 'w2', agentId: 'a2' }), { code: 'REQUEST_CONFLICT' });
});
