import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateProfile, createConnectorHandler } from './service.mjs';
import { createNavigationSession } from '../../bridge/navigation-session.mjs';

const profile = { host: '127.0.0.1', port: 17470, token: 'a'.repeat(64),
  threadId: '11111111-1111-4111-8111-111111111111', pfxPath: 'C:\\private\\server.p12', password: 'test' };

test('installation-specific search aliases survive profile validation and malformed aliases are refused', () => {
  const searchAliases = { demo: ['示例项目'] };
  assert.deepEqual(validateProfile({ ...profile, searchAliases }).searchAliases, searchAliases);
  for (const value of [null, [], { demo: '示例' }, { demo: ['bad\nname'] }]) {
    assert.throws(() => validateProfile({ ...profile, searchAliases: value }), { code: 'INVALID_PROFILE' });
  }
});

test('service refuses public listeners and the existing production ports', () => {
  for (const replacement of [{ host: '0.0.0.0' }, { port: 7468 }, { port: 17469 }, { token: '' }]) {
    assert.throws(() => validateProfile({ ...profile, ...replacement }), { code: 'INVALID_PROFILE' });
  }
  assert.equal(validateProfile(profile).port, 17470);
  const { threadId, ...withoutThread } = profile;
  assert.equal(validateProfile({ ...withoutThread, navigation: true }).navigation, true);
  assert.throws(() => validateProfile({ ...withoutThread, navigation: 'yes' }), { code: 'INVALID_PROFILE' });
  assert.equal(validateProfile({ ...withoutThread, navigation: true, creation: true }).creation, true);
  assert.throws(() => validateProfile({ ...profile, creation: true }), { code: 'INVALID_PROFILE' });
  assert.throws(() => validateProfile({ ...withoutThread, navigation: true, creation: 'yes' }), { code: 'INVALID_PROFILE' });
});

test('shared runtime connection requires a private token file and an authenticated loopback endpoint', () => {
  const sharedConnection = { endpoint: 'ws://127.0.0.1:19570/rpc', tokenFile: 'C:\\private\\shared-token' };
  assert.deepEqual(validateProfile({ ...profile, sharedConnection }).sharedConnection, sharedConnection);
  for (const replacement of [{ endpoint: 'ws://0.0.0.0:19570/rpc' }, { endpoint: 'wss://example.com/rpc' },
    { endpoint: 'ws://user:secret@127.0.0.1:19570/rpc' }, { endpoint: 'ws://127.0.0.1:19570/rpc?token=secret' },
    { tokenFile: 'relative-token' }, { token: 'must-not-be-in-profile' }]) {
    assert.throws(() => validateProfile({ ...profile, sharedConnection: { ...sharedConnection, ...replacement } }), { code: 'INVALID_PROFILE' });
  }
});

test('navigation mode sends selection commands to the local selection controller', async t => {
  let received;
  const s = createServer(createConnectorHandler({ token: profile.token, navigation: true,
    client: { isDesktopAvailable: () => true }, gateway: { async submit(input) {
      received = input.text; return { requestId: input.requestId, status: 'control', text: '项目列表' };
    } } }));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  const r = await fetch(`http://127.0.0.1:${s.address().port}/v1/chat/completions`, { method: 'POST',
    headers: { authorization: 'Bearer ' + profile.token, 'idempotency-key': 'list-1' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '列出项目' }] }) });
  assert.equal(received, '列出项目'); assert.equal((await r.json()).codex_status, 'control');
});

async function server(t) {
  let submissions = 0;
  const client = { ready: true, isDesktopAvailable: () => true,
    snapshot: async () => ({ name: '测试对话', cwd: 'C:\\project', id: profile.threadId }) };
  const gateway = { async submit(input) { submissions++; return { requestId: input.requestId, status: 'idle', text: 'reply' }; } };
  const s = createServer(createConnectorHandler({ client, gateway, token: profile.token }));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  return { url: `http://127.0.0.1:${s.address().port}`, submissions: () => submissions };
}

for (const ready of [true, false]) {
  test(`health reports a mobile-compatible state when desktop readiness is ${ready}`, async t => {
    let submissions = 0;
    const s = createServer(createConnectorHandler({ token: profile.token, navigation: true,
      client: { isDesktopAvailable: () => ready }, gateway: { submit() { submissions++; } } }));
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
    const url = `http://127.0.0.1:${s.address().port}/healthz`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: 'Bearer ' + profile.token } });
    const health = await response.json();
    assert.equal(response.status, ready ? 200 : 503);
    assert.equal(health.ok, ready);
    assert.equal(health.status, ready ? 'ready' : 'unavailable');
    assert.equal(submissions, 0);
  });
}

test('an unauthenticated phone request cannot reach Codex', async t => {
  const s = await server(t);
  const r = await fetch(s.url + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(r.status, 401); assert.equal(s.submissions(), 0);
});

test('phone ownership handshake remains compatible with the existing mobile client', async t => {
  let state = { version: 1, owner: null, highestEpoch: 0 };
  const sessions = createNavigationSession({ backend: 'codex', invalidate() {},
    store: { load: () => state, save: next => { state = next; } } });
  const client = { isDesktopAvailable: () => true, snapshot: async () => ({ name: '测试对话' }) };
  const s = createServer(createConnectorHandler({ client, gateway: {}, token: profile.token, sessions }));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  const url = `http://127.0.0.1:${s.address().port}/v1/navigation/session`;
  const headers = { authorization: 'Bearer ' + profile.token };
  const identity = { installationId: '33333333-3333-4333-8333-333333333333', epoch: 1 };
  const challenge = await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'challenge', ...identity }) })).json();
  const binding = await (await fetch(url, { method: 'POST', headers,
    body: JSON.stringify({ action: 'bind', ...identity, challenge: challenge.challenge }) })).json();
  assert.equal(binding.binding.backend, 'codex'); assert.equal(typeof binding.binding.sessionToken, 'string');
});

test('navigation is answered locally rather than delivered to the model', async t => {
  const s = await server(t);
  const r = await fetch(s.url + '/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + profile.token, 'idempotency-key': 'control-1' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '当前 Agent' }] }) });
  const value = await r.json();
  assert.match(value.choices[0].message.content, /测试对话/); assert.equal(s.submissions(), 0);
});

test('the phone wire format can submit a normal request and receive NDJSON', async t => {
  const s = await server(t);
  const r = await fetch(s.url + '/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + profile.token, 'idempotency-key': 'task-1' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '测试问题' }] }) });
  const lines = (await r.text()).trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).status, 'idle'); assert.equal(lines.at(-1).text, 'reply');
  assert.equal(s.submissions(), 1);
});

test('shortcut routes require both authentication and phone ownership, and pass targets as controls', async t => {
  let received, resolved = 0, state = { version: 1, owner: null, highestEpoch: 0 };
  const sessions = createNavigationSession({ backend: 'codex', invalidate() {}, shortcuts: () => true,
    store: { load: () => state, save: next => { state = next; } } });
  const target = { kind: 'agent', serverId: 'codex-test-host', workspaceId: 'p', agentId: 'a' };
  const gateway = { shortcutsSupported: () => true, async resolveShortcut(input, check) { check(); resolved++; return { ...target, agentName: input.agentId }; },
    async submit(input) { input.assertCurrent(); received = input; return { requestId: input.requestId, status: 'control', text: '已切换', shortcutApplied: true }; } };
  const s = createServer(createConnectorHandler({ token: profile.token, navigation: true,
    sessions, client: { isDesktopAvailable: () => true }, gateway }));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(async () => { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); });
  const base = `http://127.0.0.1:${s.address().port}`, headers = { authorization: 'Bearer ' + profile.token };
  const post = (path, body, extra = headers) => fetch(base + path, { method: 'POST', headers: extra, body: JSON.stringify(body) });
  assert.equal((await post('/v1/shortcuts/resolve', {}, {})).status, 401);
  const missing = await post('/v1/shortcuts/select', { target });
  assert.equal(missing.status, 409); assert.equal((await missing.json()).error.code, 'NAVIGATION_SESSION_REQUIRED');
  assert.equal(received, undefined); assert.equal(resolved, 0);
  const identity = { installationId: '33333333-3333-4333-8333-333333333333', epoch: 1 };
  const challenge = await (await post('/v1/navigation/session', { action: 'challenge', ...identity })).json();
  const { binding } = await (await post('/v1/navigation/session', { action: 'bind', ...identity, challenge: challenge.challenge })).json();
  assert.equal(binding.shortcuts, true);
  const owned = { ...headers, 'x-navigation-owner': identity.installationId, 'x-navigation-epoch': '1',
    'x-navigation-session': binding.sessionToken, 'x-navigation-generation': binding.generation, 'idempotency-key': 'shortcut-request' };
  const result = await post('/v1/shortcuts/resolve', { kind: 'agent', agentId: 'a' }, owned);
  assert.equal(result.status, 200); assert.equal((await result.json()).target.agentId, 'a');
  const selected = await post('/v1/shortcuts/select', { target }, owned);
  assert.equal(selected.status, 200); assert.equal((await selected.json()).shortcutApplied, true);
  assert.deepEqual(received.shortcut, target); assert.equal(received.requestId, 'shortcut-request');
});
