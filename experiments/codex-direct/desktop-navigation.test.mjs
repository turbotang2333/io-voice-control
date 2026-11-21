import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDesktopNavigation, readDesktopCatalog } from './desktop-navigation.mjs';

function fixture() {
  const projects = [
    { projectId: 'a', label: '甲项目', projectKind: 'local', hostId: 'local', path: 'C:\\shared' },
    { projectId: 'b', label: '乙项目', projectKind: 'local', hostId: 'local', path: 'C:\\shared' },
  ];
  const threads = [
    { id: 'a1', title: '甲对话', projectId: 'a', hostId: 'local', kind: 'codex', status: 'idle' },
    { id: 'a2', title: '乙对话', projectId: 'a', hostId: 'local', kind: 'codex', status: 'idle' },
    { id: 'b1', title: '丙对话', projectId: 'b', hostId: 'local', kind: 'codex', status: 'idle' },
    { id: 'unassigned', title: '未分组测试', projectId: null, hostId: 'local', kind: 'codex', status: 'idle' },
  ];
  const sent = [], state = { data: { version: 1, requests: [], selection: { projectId: 'a', threadId: 'a1' } }, save() {} };
  let clock = 100, seq = 0;
  const client = { callerThreadId: 'host-thread', async call(name) {
    if (name === 'list_projects') return { projects };
    if (name === 'list_threads') return { threads, pinnedThreads: [] };
    throw new Error('navigation must use a gateway for model messages');
  } };
  const open = () => createDesktopNavigation(client, { state, now: () => clock, createGateway: (_client, { target, state: child }) => ({ async submit(input) {
    assert.equal(client.authorizedThreadId, target.threadId);
    sent.push({ threadId: target.threadId, projectId: state.data.selection.projectId });
    child.data.requests.push({ id: input.requestId, hash: createHash('sha256').update(input.text.trim()).digest('hex'), status: 'idle', threadId: target.threadId }); child.save();
    return { requestId: input.requestId, status: 'idle', text: target.threadId };
  } }) });
  const say = (g, text, requestId = 'request-' + ++seq) => g.submit({ requestId, text });
  return { projects, threads, sent, state, client, open, say, advance() { clock += 120001; } };
}

test('desktop project membership scopes Agent selection even when directories are identical', async () => {
  const f = fixture(), g = f.open();
  assert.match((await f.say(g, '当前项目')).text, /甲项目/);
  assert.match((await f.say(g, '当前 Agent')).text, /甲对话/);
  const names = (await f.say(g, '列出 Agent')).text;
  assert.match(names, /乙对话/); assert.doesNotMatch(names, /丙对话/);
  await f.say(g, '选择二'); await f.say(g, '查询第一条');
  await f.say(g, '列出项目'); await f.say(g, '选择 2');
  assert.equal(f.state.data.selection.threadId, undefined);
  assert.match((await f.say(g, '查询未选择')).text, /先.*Agent/);
  await f.say(g, '列出 Agent'); await f.say(g, '选择 1'); await f.say(g, '查询第二条');
  assert.deepEqual(f.sent.map(t => t.threadId), ['a2', 'b1']);
});

test('projectless conversations have an explicit separate group and controls never dispatch', async () => {
  const f = fixture(), g = f.open();
  assert.match((await f.say(g, '列出项目')).text, /未分组对话/);
  await f.say(g, '选择三');
  assert.match((await f.say(g, '列出 Agent')).text, /未分组测试/);
  assert.equal(f.sent.length, 0);
});

test('expired, deleted and moved entries never silently choose another conversation', async () => {
  const f = fixture(), g = f.open();
  await f.say(g, '列出 Agent'); f.advance();
  assert.match((await f.say(g, '选择 1')).text, /先.*列出/);
  await f.say(g, '列出 Agent'); f.threads[0].projectId = 'b';
  assert.match((await f.say(g, '选择 1')).text, /变化|失效/);
  assert.match((await f.say(g, '不应发送')).text, /变化|失效/);
  assert.equal(f.sent.length, 0);
});

test('selection restores across restart while stale numbers do not; pages use at most five entries', async () => {
  const f = fixture();
  for (let i = 3; i <= 8; i++) f.threads.push({ ...f.threads[0], id: 'a' + i, title: '对话' + i });
  const g = f.open(); await f.say(g, '列出 Agent');
  const next = (await f.say(g, '下一页')).text;
  assert.match(next, /对话6/); assert.doesNotMatch(next, /6\./);
  await f.say(g, '选择 1');
  assert.equal(f.state.data.selection.threadId, 'a6');
  const restored = f.open();
  assert.match((await f.say(restored, '当前 Agent')).text, /对话6/);
  assert.match((await f.say(restored, '选择 1')).text, /先.*列出/);
});

test('an uncertain task prevents switching targets or dispatching another message', async () => {
  const f = fixture(); f.state.data.requests.push({ id: 'old', status: 'unknown', hash: 'old' });
  const g = f.open(); await f.say(g, '列出项目');
  assert.match((await f.say(g, '选择 2')).text, /结果不明/);
  await assert.rejects(f.say(g, '下一条消息'), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.state.data.selection.projectId, 'a'); assert.equal(f.sent.length, 0);
});

test('catalog drops summaries, other hosts, ChatGPT chats and the current development thread', async () => {
  const f = fixture();
  f.threads.push({ ...f.threads[0], id: 'host-thread', title: '当前开发会话' },
    { ...f.threads[0], id: 'remote', hostId: 'remote-host' }, { ...f.threads[0], id: 'chat', kind: 'chatgpt' });
  f.threads[0].summary = 'private raw summary';
  const catalog = await readDesktopCatalog(f.client);
  assert.ok(catalog.threads.every(t => !['host-thread', 'remote', 'chat'].includes(t.id)));
  assert.ok(!JSON.stringify(catalog).includes('private raw summary'));
});

test('a replay after changing selection or restarting cannot send an old request to the new target', async () => {
  const f = fixture(), g = f.open();
  await f.say(g, '查询代号', 'original');
  await f.say(g, '列出 Agent'); await f.say(g, '选择 2');
  await f.say(g, '查询代号', 'original');
  const restored = f.open();
  assert.equal((await f.say(restored, '查询代号', 'original')).status, 'unknown');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].threadId, 'a1');
});

test('desktop recent controls never read content, dispatch, or change the authorized target', async () => {
  const f = fixture(), g = f.open();
  const selection = structuredClone(f.state.data.selection);
  f.client.authorizedThreadId = 'a1';
  f.client.call = async () => { assert.fail('unsupported recent control needs no catalog or history'); };
  for (const text of ['最近对话', '列出最近对话', '请帮我列出最近对话。']) {
    const result = await f.say(g, text);
    assert.equal(result.status, 'control');
    assert.match(result.text, /Codex暂不支持按最后发言时间列出最近对话/);
    assert.match(result.text, /列出Agent/);
  }
  assert.deepEqual(f.state.data.selection, selection);
  assert.equal(f.client.authorizedThreadId, 'a1');
  assert.equal(f.sent.length, 0);
  assert.ok(f.state.data.requests.every(r => r.kind === 'control'));
});

test('desktop invalidation rejects pending lists and preserves selected and authorized identities', async () => {
  const f = fixture(), g = f.open(); f.client.authorizedThreadId = 'a1';
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const call = f.client.call;
  f.client.call = async (name, args) => { const value = await call(name, args); enter(); await waiting; return value; };
  const pending = f.say(g, '列出项目'); await entered;
  g.invalidateListing(); release();
  assert.doesNotMatch((await pending).text, /1\./);
  assert.deepEqual(f.state.data.selection, { projectId: 'a', threadId: 'a1' });
  assert.equal(f.client.authorizedThreadId, 'a1');
  f.client.call = call;
  assert.match((await f.say(g, '选择 1')).text, /先.*列出/);
  assert.equal(f.sent.length, 0);
});
