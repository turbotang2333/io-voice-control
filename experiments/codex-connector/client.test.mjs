import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QueueClient, connectorEnvironment } from './client.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const target = '11111111-1111-4111-8111-111111111111';
const fixture = fileURLToPath(new URL('./rpc.fixture.mjs', import.meta.url));
function client(t, mode = 'normal', catalog = false, readOnly = false, creationScope) {
  const value = new QueueClient({ executable: process.execPath, threadId: target, timeoutMs: 2000,
    catalog, readOnly, creationScope,
    spawnProcess(exe, args, options) {
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.ok(!Object.keys(options.env).some(k => /^(CODEX_|PASEO_)/.test(k)));
      return spawn(exe, [fixture, mode], options);
    } });
  t.after(() => value.close()); return value;
}

test('drops developer identities while preserving ordinary user settings', () => {
  assert.deepEqual(connectorEnvironment({ USERPROFILE: 'profile', PATH: 'bin', CODEX_THREAD_ID: 'private',
    CODEX_HOME: 'wrong', PASEO_AGENT_ID: 'private' }), { USERPROFILE: 'profile', PATH: 'bin' });
});

test('independent client initializes and reads a bound thread through the real stdio transport', async t => {
  const c = client(t); await c.connect();
  assert.equal((await c.snapshot()).id, target);
  assert.equal((await c.turns())[0].status, 'completed');
  assert.deepEqual(await c.queued(), []);
  assert.equal(c.ready, true);
});

test('tool activity reads only the authorized snapshot path obtained through native RPC', async t => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'client-tool-')), sessions = join(root, 'sessions'); mkdirSync(sessions);
  const path = join(sessions, 'synthetic.jsonl'), record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  writeFileSync(path, record('session_meta', { id: target }) + record('event_msg', { type: 'task_started', turn_id: 'turn-1' })
    + record('response_item', { type: 'function_call', name: 'sleep', call_id: 'call-1', arguments: '{}' }));
  const c = new QueueClient({ executable: process.execPath, threadId: target, codexHome: root,
    spawnProcess: (exe, args, options) => spawn(exe, [fixture, 'activity', path], options) });
  t.after(async () => { await c.close(); assert.ok(resolve(root).startsWith(resolve(parent))); rmSync(root, { recursive: true, force: true }); });
  await c.connect();
  assert.equal(c.toolActivity('turn-1'), false); // No arbitrary path discovery.
  await c.snapshot(); assert.equal(c.toolActivity('turn-1'), true);
  assert.equal(c.readToolActivity('unbound-thread', 'turn-1'), false);
  assert.equal(c.toolActivity('unbound-turn'), false);
  appendFileSync(path, record('response_item', { type: 'function_call_output', call_id: 'call-1', output: '' }));
  assert.equal(c.toolActivity('turn-1'), false);
});

test('client cannot take over a writer or read another thread', async t => {
  const c = client(t); await c.connect();
  await assert.rejects(c.request('thread/resume', { threadId: target }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(c.request('thread/read', { threadId: 'other' }), { code: 'INVALID_TARGET' });
});

test('queue submission preserves client identity for matching the eventual reply', async t => {
  const c = client(t); await c.connect();
  const id = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(await c.enqueue('question', id), { id: 'queue-1', clientUserMessageId: id });
});

test('malformed server output closes the connection rather than continuing with stale state', async t => {
  const c = client(t, 'malformed'); await c.connect();
  await assert.rejects(c.snapshot(), { code: 'INVALID_RPC' });
  assert.equal(c.ready, false);
});

test('server exit fails the pending read without retrying', async t => {
  const c = client(t, 'exit'); await c.connect();
  await assert.rejects(c.snapshot(), { code: 'CODEX_DISCONNECTED' });
  assert.equal(c.ready, false);
});

test('approval observations use only a shared runtime and its current bound turn', async t => {
  const independent = client(t); await independent.connect();
  assert.equal(await independent.approvalActivity('turn-1'), false);
  for (const mode of ['approval', 'not-loaded', 'input-wait', 'finished', 'other-turn']) {
    const c = new QueueClient({ threadId: target,
      sharedConnection: { endpoint: 'ws://127.0.0.1:19570/rpc', tokenFile: 'C:\\private\\token' },
      spawnProcess(exe, args, options) {
        assert.equal(exe, process.execPath);
        assert.equal(options.env.RAYNEO_SHARED_TOKEN_FILE, 'C:\\private\\token');
        assert.equal(options.env.RAYNEO_SHARED_WS_URL, 'ws://127.0.0.1:19570/rpc');
        return spawn(process.execPath, [fixture, mode], options);
      } });
    t.after(() => c.close()); await c.connect();
    assert.equal(await c.approvalActivity('turn-1'), mode === 'approval');
    assert.equal(await c.readApprovalActivity('unbound', 'turn-1'), false);
    await assert.rejects(c.request('thread/resume', { threadId: target }), { code: 'METHOD_NOT_ALLOWED' });
  }
});

test('catalog access is opt-in and removes chat previews from navigation data', async t => {
  const disabled = client(t); await disabled.connect();
  await assert.rejects(disabled.projectPage(), { code: 'METHOD_NOT_ALLOWED' });
  const c = client(t, 'normal', true); await c.connect();
  assert.equal((await c.projectPage()).data[0].name, '正式项目');
  const page = await c.threadPage();
  assert.equal(Object.hasOwn(page.data[0], 'preview'), false);
  const bound = c.bindThread('catalog-thread');
  assert.equal((await bound.snapshot()).id, 'catalog-thread');
  assert.equal(Object.isFrozen(bound), true);
  assert.throws(() => c.bindThread('not-listed'), { code: 'INVALID_TARGET' });
});

test('recent-history access is limited to listed threads and exposes user timestamps without message content', async t => {
  const c = client(t, 'normal', true); await c.connect();
  await assert.rejects(c.userTimePage('not-listed'), { code: 'INVALID_TARGET' });
  await c.threadPage();
  const page = await c.userTimePage('catalog-thread');
  assert.deepEqual(page.data[0].items, [{ type: 'userMessage', startedAtMs: 1234 }]);
  assert.doesNotMatch(JSON.stringify(page), /must-not-expose|content|clientId|agentMessage/);
  await assert.rejects(c.request('thread/turns/list', { threadId: 'catalog-thread', itemsView: 'full' }), { code: 'INVALID_TARGET' });
});

test('a search reader can read a selected history but cannot enqueue even into its bound thread', async t => {
  const c = client(t, 'normal', true, true); await c.connect(); await c.threadPage();
  const bound = c.bindThread('catalog-thread');
  assert.equal((await bound.snapshot()).id, 'catalog-thread');
  assert.equal((await bound.turns())[0].status, 'completed');
  await assert.rejects(bound.enqueue('must never be sent', 'read-only-test'), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(c.request('thread/queue/add', { threadId: target }), { code: 'METHOD_NOT_ALLOWED' });
});

test('an explicitly scoped creator creates and names one empty thread but cannot send or resume', async t => {
  const c = client(t, 'normal', false, false, { projectId: 'project-1', cwd: 'C:\\project' }); await c.connect();
  let reserved;
  const snapshot = await c.createEmpty('新对话', id => { reserved = id; });
  assert.equal(snapshot.id, 'new-thread'); assert.equal(reserved, 'new-thread'); assert.equal(snapshot.name, '新对话');
  await assert.rejects(c.createEmpty('另一条'), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(c.request('thread/queue/add', { threadId: 'new-thread' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(c.request('thread/resume', { threadId: 'new-thread' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(c.request('thread/name/set', { threadId: target, name: '改旧对话' }), { code: 'METHOD_NOT_ALLOWED' });
});

test('ordinary and read-only clients cannot create threads, and creation scope cannot be overridden', async t => {
  const ordinary = client(t); await ordinary.connect();
  await assert.rejects(ordinary.request('thread/start', {}), { code: 'METHOD_NOT_ALLOWED' });
  const scoped = client(t, 'normal', false, false, { projectId: 'project-1', cwd: 'C:\\project' }); await scoped.connect();
  await assert.rejects(scoped.request('thread/start', { projectId: 'other', cwd: 'C:\\other' }), { code: 'METHOD_NOT_ALLOWED' });
  assert.throws(() => client(t, 'normal', false, true, { projectId: 'project-1', cwd: 'C:\\project' }), { code: 'INVALID_CREATION_SCOPE' });
});

test('restoring empty-thread metadata never grants concurrent history or enqueue access', async t => {
  const c = client(t, 'normal', true); await c.connect();
  const pending = c.storedCreationSnapshot('unlisted-created');
  await assert.rejects(c.request('thread/turns/list', { threadId: 'unlisted-created', itemsView: 'full' }), { code: 'INVALID_TARGET' });
  await assert.rejects(c.request('thread/queue/add', { threadId: 'unlisted-created' }), { code: 'INVALID_TARGET' });
  assert.equal((await pending).id, 'unlisted-created');
  assert.throws(() => c.bindThread('unlisted-created'), { code: 'INVALID_TARGET' });
});
