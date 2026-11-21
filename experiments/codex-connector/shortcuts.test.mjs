import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './shortcuts.mjs';

function fixture() {
  const thread = { id: 'a', name: '原对话', projectId: 'p', cwd: 'C:\\project' };
  let snapshot = () => ({ ...thread });
  const client = {
    projectPage: async () => ({ data: [{ id: 'p', name: '项目', roots: [{ path: 'C:\\project' }] }] }),
    threadPage: async () => ({ data: [{ ...thread }] }),
    bindThread: () => ({ snapshot: async () => snapshot() }),
  };
  return { thread, client, setSnapshot(fn) { snapshot = fn; },
    shortcuts: api.createConnectorShortcuts(client, { serverId: 'codex-test-host' }) };
}

test('shortcut binding resolves an original thread or its project without reading messages', async () => {
  const f = fixture();
  assert.deepEqual(await f.shortcuts.resolve({ kind: 'agent', agentId: 'a' }), {
    kind: 'agent', serverId: 'codex-test-host', workspaceId: 'p', workspaceName: '项目', agentId: 'a', agentName: '原对话',
  });
  assert.deepEqual(await f.shortcuts.resolve({ kind: 'workspace', agentId: 'a' }), {
    kind: 'workspace', serverId: 'codex-test-host', workspaceId: 'p', workspaceName: '项目',
  });
});

test('another host, removed thread, or changed project cannot be used as a shortcut', async () => {
  const f = fixture(), target = await f.shortcuts.resolve({ kind: 'agent', agentId: 'a' });
  await assert.rejects(f.shortcuts.verify({ ...target, serverId: 'other-host' }), { code: 'SHORTCUT_HOST_CHANGED' });
  f.setSnapshot(() => ({ ...f.thread, projectId: 'other' }));
  await assert.rejects(f.shortcuts.verify(target), { code: 'SHORTCUT_TARGET_UNAVAILABLE' });
  f.thread.canAcceptDirectInput = false;
  await assert.rejects(f.shortcuts.verify(target), { code: 'SHORTCUT_TARGET_UNAVAILABLE' });
});

test('a changed phone session stops shortcut verification before it returns a usable target', async () => {
  const f = fixture(); let current = true;
  f.setSnapshot(() => { current = false; return { ...f.thread }; });
  await assert.rejects(f.shortcuts.resolve({ kind: 'agent', agentId: 'a' }, () => {
    if (!current) throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' });
  }), { code: 'NAVIGATION_SESSION_STALE' });
});

test('invalid shortcut inputs cannot authorize a new target', async () => {
  const f = fixture();
  for (const input of [null, {}, { kind: 'agent', agentId: '../x' }, { kind: 'other', agentId: 'a' }]) {
    await assert.rejects(f.shortcuts.resolve(input), { code: 'INVALID_INPUT' });
  }
  const disabled = api.createConnectorShortcuts(f.client, {});
  assert.equal(disabled.supported(), false);
});
