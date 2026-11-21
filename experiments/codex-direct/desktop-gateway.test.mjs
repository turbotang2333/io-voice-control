import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopGateway } from './desktop-gateway.mjs';

test('desktop read finishing after a session switch cannot dispatch or leave an unknown journal', async () => {
  const h = harness(); let valid = true;
  const call = h.client.call;
  h.client.call = async (name, args) => {
    const result = await call(name, args);
    if (name === 'read_thread') valid = false;
    return result;
  };
  await assert.rejects(h.gateway.submit({ requestId: 'stale', text: '查询代号', assertCurrent() {
    if (!valid) throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' });
  } }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(h.sends(), 0); assert.equal(h.state.data.requests.length, 0);
  h.client.call = call;
  assert.equal((await h.gateway.submit({ requestId: 'fresh', text: '查询代号' })).status, 'idle');
});

function harness({ pending = false, wrongTarget = false, delegated = false, foreignCaller = false, truncated = false, waitUnavailable = false } = {}) {
  let sends = 0;
  const state = { data: { version: 1, requests: [] }, save() {} };
  const ownTurn = { id: 'new-turn', status: 'completed', items: delegated ? [{ type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app',
    output: { text: `<codex_delegation>\n  <source_thread_id>${foreignCaller ? 'other-caller' : 'caller'}</source_thread_id>\n  <input>查询代号</input>\n</codex_delegation>`, truncated } }]
    : [{ type: 'userMessage', content: [{ type: 'text', text: '查询代号' }] }] };
  ownTurn.items.push({ type: 'agentMessage', turnId: 'new-turn', text: '白鹭', phase: 'final_answer' });
  const client = { authorizedThreadId: 'target', callerThreadId: 'caller', async call(name) {
    if (name === 'read_thread') return { thread: { id: 'target', status: { type: pending ? 'active' : 'idle' } }, turns: sends ? [ownTurn] : [{ id: 'old-turn' }] };
    if (name === 'send_message_to_thread') { sends++; return { threadId: wrongTarget ? 'other' : 'target' }; }
    if (name === 'wait_threads' && waitUnavailable) throw Object.assign(new Error(), { code: 'DESKTOP_MCP_REJECTED' });
    if (name === 'wait_threads') return { polls: [{ thread: { id: 'target', status: { type: 'idle' } }, cursor: 'new-cursor', latestTurn: ownTurn,
      latestAssistantMessage: { turnId: 'new-turn', text: '白鹭', phase: 'final_answer' } }] };
    throw new Error(name);
  } };
  const gateway = createDesktopGateway(client, { state, target: { threadId: 'target', hostId: 'local', title: '测试对话' } });
  return { gateway, client, state, sends: () => sends };
}

test('desktop gateway continues only the bound conversation and does not persist its text', async () => {
  const h = harness();
  const reply = await h.gateway.submit({ requestId: 'one', text: '查询代号' });
  assert.equal(reply.text, '白鹭'); assert.equal(reply.status, 'idle'); assert.equal(h.sends(), 1);
  assert.ok(!JSON.stringify(h.state.data).includes('查询代号'));
  assert.ok(!JSON.stringify(h.state.data).includes('白鹭'));
});

test('duplicate IDs and restart records never dispatch a second desktop message', async () => {
  const h = harness();
  await h.gateway.submit({ requestId: 'one', text: '查询代号' });
  await h.gateway.submit({ requestId: 'one', text: '查询代号' });
  const restarted = createDesktopGateway(h.client, { state: h.state, target: { threadId: 'target', hostId: 'local' } });
  assert.equal((await restarted.submit({ requestId: 'one', text: '查询代号' })).status, 'unknown');
  assert.equal(h.sends(), 1);
});

test('a running desktop task is left alone and navigation never sends a model message', async () => {
  const h = harness({ pending: true });
  await h.gateway.submit({ requestId: 'nav', text: '当前项目' });
  await assert.rejects(h.gateway.submit({ requestId: 'busy', text: '查询代号' }), { code: 'CODEX_BUSY' });
  assert.equal(h.sends(), 0); assert.equal(h.state.data.requests.length, 0);
});

test('mismatched dispatch receipts stop the experiment without trying another target', async () => {
  const h = harness({ wrongTarget: true });
  assert.equal((await h.gateway.submit({ requestId: 'one', text: '查询代号' })).status, 'unknown');
  await assert.rejects(h.gateway.submit({ requestId: 'two', text: '另一条' }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(h.sends(), 1);
});

test('a desktop turn with another user message cannot be returned as the glasses answer', async () => {
  const h = harness();
  const original = h.client.call;
  h.client.call = async (name, args) => {
    const r = await original(name, args);
    if (name === 'read_thread' && h.sends()) r.turns[0].items[0].content[0].text = '桌面插入的其他消息';
    return r;
  };
  assert.equal((await h.gateway.submit({ requestId: 'one', text: '查询代号' })).status, 'unknown');
});

test('real desktop transfer messages are matched by caller, target, turn and exact input', async () => {
  const h = harness({ delegated: true });
  const result = await h.gateway.submit({ requestId: 'one', text: '查询代号' });
  assert.equal(result.status, 'idle'); assert.equal(result.text, '白鹭'); assert.equal(h.sends(), 1);
});

test('another caller or a truncated transfer cannot satisfy reply ownership checks', async () => {
  for (const options of [{ delegated: true, foreignCaller: true }, { delegated: true, truncated: true }]) {
    const h = harness(options);
    assert.equal((await h.gateway.submit({ requestId: 'one', text: '查询代号' })).status, 'unknown');
    assert.equal(h.sends(), 1);
  }
});

test('project conversations can finish through read_thread when wait_threads is unavailable', async () => {
  const h = harness({ delegated: true, waitUnavailable: true });
  const result = await h.gateway.submit({ requestId: 'one', text: '查询代号' });
  assert.equal(result.status, 'idle'); assert.equal(result.text, '白鹭'); assert.equal(h.sends(), 1);
});
