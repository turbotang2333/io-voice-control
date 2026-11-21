import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createVoiceGateway } from '../bridge/voice-selection.mjs';
import { createNavigationSession } from '../bridge/navigation-session.mjs';
import { createRequestHandler } from '../bridge/http.mjs';

function fixture() {
  let serverId = 'host-one';
  const workspaces = [{ id: 'w1', title: '日常', project: { projectKey: 'p1' } },
    { id: 'w2', title: '日常', project: { projectKey: 'p2' } }];
  const agents = [{ id: 'a1', workspaceId: 'w1', title: '记录', status: 'idle' },
    { id: 'a2', workspaceId: 'w2', title: '闲聊', status: 'idle' }];
  const sent = [], saved = [];
  const client = { getServerId: () => serverId,
    workspaces: { list: async () => ({ entries: workspaces, pageInfo: {} }) },
    agents: { list: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: {} }),
      ref: id => { let listener; return { refresh: async () => ({ agent: agents.find(a => a.id === id) }),
        timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
        run: async (text, options) => { listener({ agentId: id, event: { type: 'timeline', turnId: 'test-turn', item: { type: 'user_message', messageId: options.messageId } } });
          sent.push({ id, text }); return { status: 'idle', final: { id }, lastMessage: 'ok' }; } }; } } };
  const stateStore = { getSelection: () => ({ workspaceId: 'w1', agentId: 'a1' }),
    saveSelection: v => saved.push(v), reserveRequest() {}, findRequest() {} };
  const gateway = createVoiceGateway(client, { allowUnselected: true, stateStore });
  return { client, gateway, workspaces, agents, sent, saved, stateStore, changeHost: id => { serverId = id; } };
}
const target = { kind: 'agent', serverId: 'host-one', workspaceId: 'w2', agentId: 'a2' };

test('legacy workspace identities with Chinese, spaces and path punctuation remain opaque exact IDs', async () => {
  const f = fixture();
  const legacyId = 'D:\\示例 工作区\\记录';
  f.workspaces[1].id = legacyId; f.agents[1].workspaceId = legacyId;
  const found = await f.gateway.resolveShortcut({ kind: 'agent', agentId: 'a2' }, () => {});
  assert.equal(found.workspaceId, legacyId);
  const result = await f.gateway.submit({ requestId: 'legacy-workspace-agent', text: '快捷切换', shortcut: found });
  assert.equal(result.shortcutApplied, true); assert.deepEqual(f.saved, [{ workspaceId: legacyId, agentId: 'a2' }]);
  const workspace = await f.gateway.resolveShortcut({ kind: 'workspace', agentId: 'a2' }, () => {});
  assert.equal(workspace.workspaceId, legacyId); assert.equal(workspace.agentId, undefined);
  const selected = await f.gateway.submit({ requestId: 'legacy-workspace-only', text: '快捷切换', shortcut: workspace });
  assert.equal(selected.shortcutApplied, true);
  assert.deepEqual(f.saved[1], { workspaceId: legacyId }); assert.deepEqual(f.sent, []);
  const invalid = await f.gateway.submit({ requestId: 'invalid-workspace-control', text: '快捷切换',
    shortcut: { ...found, workspaceId: 'D:\\示例\n工作区' } });
  assert.equal(invalid.shortcutApplied, undefined); assert.equal(f.saved.length, 2);
});

test('resolves a pasted Agent ID without selecting, sending, creating, or reading history', async () => {
  const f = fixture();
  const found = await f.gateway.resolveShortcut({ kind: 'agent', agentId: 'a2' }, () => {});
  assert.deepEqual(found, { ...target, workspaceName: '日常', agentName: '闲聊' });
  assert.deepEqual(f.saved, []); assert.deepEqual(f.sent, []);
  const workspace = await f.gateway.resolveShortcut({ kind: 'workspace', agentId: 'a2' }, () => {});
  assert.equal(workspace.workspaceId, 'w2'); assert.equal(workspace.agentId, undefined);
});

test('switches by identities across same-named workspaces and routes only a later confirmed question', async () => {
  const f = fixture();
  const r = await f.gateway.submit({ requestId: 'shortcut-one', text: '快捷切换', shortcut: target });
  assert.equal(r.status, 'control'); assert.match(r.text, /闲聊/);
  assert.deepEqual(f.saved, [{ workspaceId: 'w2', agentId: 'a2' }]);
  assert.deepEqual(f.sent, []);
  await f.gateway.submit({ requestId: 'question-after-switch', text: 'hello' });
  assert.deepEqual(f.sent, [{ id: 'a2', text: 'hello' }]);
});

test('workspace shortcut survives deletion of its seed Agent and lists the remaining Agents', async () => {
  const f = fixture();
  const resolved = await f.gateway.resolveShortcut({ kind: 'workspace', agentId: 'a2' }, () => {});
  f.agents.pop(); f.agents.push({ id: 'a3', workspaceId: 'w2', title: '新的闲聊', status: 'idle' });
  const r = await f.gateway.submit({ requestId: 'workspace-switch', text: '快捷切换', shortcut: resolved });
  assert.equal(r.status, 'control'); assert.match(r.text, /新的闲聊/);
  assert.deepEqual(f.saved, [{ workspaceId: 'w2' }]); assert.deepEqual(f.sent, []);
  const refresh = await f.gateway.resolveShortcut({ target: resolved }, () => {});
  assert.equal(refresh.workspaceId, 'w2'); assert.equal(refresh.agentId, undefined);
});

test('rejects a different host, missing or archived target, and moved Agent without fallback', async () => {
  for (const mutation of [f => f.changeHost('other-host'), f => { f.agents.length = 0; },
    f => { f.agents[1].archivedAt = '2026-01-01'; }, f => { f.workspaces[1].archivedAt = '2026-01-01'; },
    f => { f.agents[1].workspaceId = 'w1'; }]) {
    const f = fixture(); mutation(f);
    const r = await f.gateway.submit({ requestId: 'bad-target', text: '快捷切换', shortcut: target });
    assert.equal(r.status, 'control'); assert.match(r.text, /未切换/);
    assert.deepEqual(f.saved, []); assert.deepEqual(f.sent, []);
  }
});

test('failed selection storage keeps the original target and never reports a successful switch', async () => {
  const f = fixture();
  f.stateStore.saveSelection = () => { throw Object.assign(Error('disk'), { code: 'STATE_WRITE_FAILED' }); };
  const result = await f.gateway.submit({ requestId: 'storage-fail', text: '快捷切换', shortcut: target });
  assert.equal(result.shortcutApplied, undefined); assert.match(result.text, /未切换/);
  assert.deepEqual(f.sent, []);
  await f.gateway.submit({ requestId: 'question-keeps-old-target', text: 'hello' });
  assert.deepEqual(f.sent, [{ id: 'a1', text: 'hello' }]);
});

test('an active model request blocks switching and a missing target never becomes a model request', async () => {
  const f = fixture(); let release, entered;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const original = f.client.agents.ref;
  f.client.agents.ref = id => ({ ...original(id), run: async text => { entered(); await held; f.sent.push({ id, text }); return { status: 'idle', lastMessage: 'ok' }; } });
  const pending = f.gateway.submit({ requestId: 'active', text: 'hello' }); await started;
  const blocked = await f.gateway.submit({ requestId: 'blocked', text: '快捷切换', shortcut: target });
  assert.equal(blocked.status, 'control'); assert.equal(blocked.shortcutApplied, undefined); assert.deepEqual(f.saved, []);
  release(); await pending;
  const missing = await f.gateway.submit({ requestId: 'invalid', text: '快捷切换', shortcut: null });
  assert.equal(missing.status, 'control'); assert.deepEqual(f.sent, [{ id: 'a1', text: 'hello' }]);
});

test('deduplication includes the target and never repeats an old shortcut after another selection', async () => {
  const f = fixture(); const input = { requestId: 'same-id', text: '快捷切换', shortcut: target };
  await f.gateway.submit(input); await f.gateway.submit(input);
  assert.equal(f.saved.length, 1);
  await assert.rejects(f.gateway.submit({ ...input, shortcut: { kind: 'workspace', serverId: 'host-one', workspaceId: 'w1' } }), /同一请求编号/);
  assert.deepEqual(f.sent, []);
});

test('connection or listing changes during target validation cannot commit a shortcut selection', async () => {
  const f = fixture(); let valid = true;
  const original = f.client.agents.ref;
  f.client.agents.ref = id => ({ ...original(id), refresh: async () => {
    valid = false; return { agent: f.agents.find(a => a.id === id) };
  } });
  const r = await f.gateway.submit({ requestId: 'stale-target', text: '快捷切换', shortcut: target,
    assertCurrent: () => { if (!valid) throw Object.assign(Error('stale'), { code: 'NAVIGATION_SESSION_STALE' }); } });
  assert.equal(r.status, 'control'); assert.deepEqual(f.saved, []); assert.deepEqual(f.sent, []);
});

test('dedicated shortcut routes require Bearer and current navigation session and cannot fall into chat', async t => {
  const f = fixture(), owner = '11111111-1111-4111-8111-111111111111';
  let state = { version: 1, owner: null, highestEpoch: 0 };
  const sessions = createNavigationSession({ backend: 'paseo', shortcuts: f.gateway.shortcutsSupported,
    store: { load: () => state, save: s => { state = s; } }, invalidate: f.gateway.invalidateListing });
  const server = createServer(createRequestHandler({ token: 'test-token', gateway: f.gateway, sessions }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, extra = {}, token = true) => fetch(base + url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer test-token' } : {}), ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/v1/shortcuts/resolve', { kind: 'agent', agentId: 'a2' }, {}, false)).status, 401);
  assert.equal((await post('/v1/shortcuts/select', { target }, {})).status, 409);
  const identity = { installationId: owner, epoch: 1 };
  const challenge = await (await post('/v1/navigation/session', { action: 'challenge', ...identity })).json();
  const { binding } = await (await post('/v1/navigation/session', { action: 'bind', ...identity, challenge: challenge.challenge })).json();
  assert.equal(binding.shortcuts, true);
  const headers = { 'x-navigation-owner': owner, 'x-navigation-epoch': '1', 'x-navigation-session': binding.sessionToken,
    'x-navigation-generation': binding.generation, 'idempotency-key': 'endpoint-shortcut' };
  const found = await post('/v1/shortcuts/resolve', { kind: 'agent', agentId: 'a2' }, headers);
  assert.equal(found.status, 200); assert.equal((await found.json()).target.agentId, 'a2');
  assert.deepEqual(f.saved, []);
  const selected = await post('/v1/shortcuts/select', { target }, headers);
  assert.equal(selected.status, 200); assert.equal((await selected.json()).status, 'control');
  assert.deepEqual(f.sent, []);
  const missing = await post('/v1/shortcuts/select', {}, { ...headers, 'idempotency-key': 'missing-target' });
  assert.equal(missing.status, 400); assert.deepEqual(f.sent, []);
});
