import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createCodexGateway, openExperimentState } from './gateway.mjs';
import { createHandler } from './http.mjs';

class Rpc extends EventEmitter {
  closed = false;
  starts = 0;
  async request(method) {
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'experiment-thread', status: { type: 'idle' } } };
    if (method === 'turn/start') {
      this.starts++;
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'unrelated-thread', turnId: 'own-turn', itemId: 'other', delta: '不应显示' } });
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'experiment-thread', turnId: 'previous-turn', itemId: 'other', delta: '不应显示' } });
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'experiment-thread', turnId: 'own-turn', itemId: 'message', delta: '收到' } });
      return { turn: { id: 'own-turn' } };
    }
  }
  finish() {
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'experiment-thread', turn: { id: 'own-turn', status: 'completed' } } });
  }
}
function stateFile(t) {
  const root = join(homedir(), '.local', 'state', 'rayneo-paseo', 'codex-direct', 'tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'case-'));
  t.after(() => { assert.ok(directory.startsWith(join(root, 'case-'))); rmSync(directory, { recursive: true, force: true }); });
  return join(directory, 'state.json');
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Codex factory resume and reentrant progress callbacks cannot bypass a changed session', async t => {
  const rpc = new Rpc(), state = openExperimentState(stateFile(t)); let valid = true;
  const guard = () => { if (!valid) throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' }); };
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, args) => { const value = await request(method, args); valid = false; return value; };
  await assert.rejects(createCodexGateway(rpc, { state, cwd: 'sandbox', assertCurrent: guard }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(state.data.threadId, undefined);
  rpc.request = request; valid = true;
  const gateway = await createCodexGateway(rpc, { state, cwd: 'sandbox', assertCurrent: guard });
  await assert.rejects(gateway.submit({ requestId: 'guarded', text: '测试', assertCurrent: guard,
    onUpdate() { valid = false; } }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(rpc.starts, 0); assert.equal(state.data.requests.length, 0);
});

test('a progress callback cannot reenter a second Codex submission before the first pre-send record', async t => {
  const rpc = new Rpc(), state = openExperimentState(stateFile(t));
  const gateway = await createCodexGateway(rpc, { state, cwd: 'sandbox' });
  let second;
  const first = gateway.submit({ requestId: 'outer', text: '测试', onUpdate() {
    second ??= gateway.submit({ requestId: 'inner', text: '另一条' });
    second.catch(() => {});
  } });
  await assert.rejects(second, { code: 'CODEX_BUSY' });
  await tick(); rpc.finish(); await first;
  assert.equal(rpc.starts, 1);
});

test('filters other sessions and old turns, including notifications before start response', async t => {
  const rpc = new Rpc();
  const gateway = await createCodexGateway(rpc, { state: openExperimentState(stateFile(t)), cwd: 'sandbox' });
  const updates = [];
  const result = gateway.submit({ requestId: 'first', text: '测试', onUpdate: update => updates.push(update) });
  await tick(); rpc.finish();
  assert.equal((await result).text, '收到');
  assert.deepEqual(updates.filter(u => u.type === 'text').map(u => u.text), ['收到']);
});

test('same request is sent once; conflicts and simultaneous new tasks are rejected', async t => {
  const rpc = new Rpc();
  const gateway = await createCodexGateway(rpc, { state: openExperimentState(stateFile(t)), cwd: 'sandbox' });
  const first = gateway.submit({ requestId: 'same', text: '测试' });
  const duplicate = gateway.submit({ requestId: 'same', text: '测试' });
  await assert.rejects(gateway.submit({ requestId: 'same', text: '变更正文' }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(gateway.submit({ requestId: 'different', text: '另一条' }), { code: 'CODEX_BUSY' });
  await tick(); rpc.finish();
  assert.equal((await first).text, (await duplicate).text);
  assert.equal(rpc.starts, 1);
});

test('restart retains dedup record without storing the conversation body', async t => {
  const file = stateFile(t);
  const rpc = new Rpc();
  const gateway = await createCodexGateway(rpc, { state: openExperimentState(file), cwd: 'sandbox' });
  const first = gateway.submit({ requestId: 'persisted', text: '私有测试正文' });
  await tick(); rpc.finish(); await first;
  const restored = openExperimentState(file);
  assert.ok(!JSON.stringify(restored.data).includes('私有测试正文'));
  const next = await createCodexGateway(rpc, { state: restored, cwd: 'sandbox' });
  assert.equal((await next.submit({ requestId: 'persisted', text: '私有测试正文' })).status, 'unknown');
  assert.equal(rpc.starts, 1);
});

test('an uncertain outcome stops new submissions and never retries automatically', async t => {
  const rpc = new Rpc();
  const gateway = await createCodexGateway(rpc, { state: openExperimentState(stateFile(t)), cwd: 'sandbox', timeoutMs: 15 });
  assert.equal((await gateway.submit({ requestId: 'uncertain', text: '测试' })).status, 'timeout');
  await assert.rejects(gateway.submit({ requestId: 'next', text: '另一条' }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(rpc.starts, 1);
});

test('authorization requests are reported rather than treated as successful replies', async t => {
  const rpc = new Rpc();
  const gateway = await createCodexGateway(rpc, { state: openExperimentState(stateFile(t)), cwd: 'sandbox' });
  const result = gateway.submit({ requestId: 'permission', text: '测试' });
  await tick(); rpc.emit('permission', { threadId: 'experiment-thread' }); rpc.finish();
  assert.equal((await result).status, 'permission');
});

test('resuming an existing Codex conversation preserves its working directory and permission settings', async t => {
  const file = stateFile(t), state = openExperimentState(file);
  state.data.threadId = 'existing-thread'; state.save();
  const calls = [];
  const rpc = new Rpc();
  rpc.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'existing-thread', cwd: 'C:\\Projects\\Existing', status: { type: 'notLoaded' } } };
  };
  await createCodexGateway(rpc, { state, cwd: 'C:\\Projects\\Existing', preserveConfig: true });
  assert.deepEqual(calls[0], { method: 'thread/resume', params: { threadId: 'existing-thread', excludeTurns: true } });
});

test('installed phone wire contract works and requires the separate experiment token', async t => {
  let submitted = 0;
  const server = createServer(createHandler({ token: 'a'.repeat(64), gateway: {
    async submit({ requestId, onUpdate }) {
      submitted++; onUpdate({ type: 'text', text: '收到' });
      return { requestId, status: 'idle', text: '收到' };
    },
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/healthz')).status, 401);
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + 'a'.repeat(64), 'idempotency-key': 'phone', 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: '测试' }] }),
  });
  const frames = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(response.status, 200);
  assert.equal(frames.at(-1).type, 'done');
  assert.equal(frames.at(-1).text, '收到');
  assert.equal(submitted, 1);
});
