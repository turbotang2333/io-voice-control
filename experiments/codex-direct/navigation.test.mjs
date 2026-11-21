import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('./navigation.mjs').catch(() => ({}));
function fixture({ resumeError } = {}) {
  const threads = [
    { id: 'a1', cwd: 'C:\\Projects\\Alpha', name: '甲会话', status: { type: 'notLoaded' } },
    { id: 'a2', cwd: 'C:\\Projects\\Alpha', name: '乙会话', status: { type: 'idle' } },
    { id: 'b1', cwd: 'C:\\Projects\\Beta', name: '丙会话', status: { type: 'notLoaded' } },
  ];
  const sent = [];
  const state = { data: { version: 1, threadId: 'a1', requests: [] }, save() {} };
  const rpc = { closed: false, async request(method, p) {
    if (method === 'thread/list') return { data: threads.filter(t => !p.cwd || t.cwd === p.cwd), nextCursor: null };
    if (method === 'thread/read') return { thread: threads.find(t => t.id === p.threadId) };
    throw new Error('Navigation must not start or resume a conversation');
  } };
  async function open() {
    assert.equal(typeof api.createCodexNavigation, 'function', 'navigation must be implemented');
    return api.createCodexNavigation(rpc, { state, cwd: threads[0].cwd,
      createGateway: async (_rpc, options) => {
        if (resumeError) throw Object.assign(new Error(), { code: resumeError });
        return { async submit(input) {
        sent.push({ id: options.state.data.threadId, cwd: options.cwd, text: input.text, preserveConfig: options.preserveConfig });
        return { requestId: input.requestId, status: 'idle', text: options.state.data.threadId };
        } };
      },
    });
  }
  let next = 0;
  const say = (gateway, text, requestId = 'request-' + ++next) => gateway.submit({ requestId, text });
  return { threads, state, sent, rpc, open, say };
}

test('project and Agent switches route messages to the selected real Codex thread', async () => {
  const f = fixture(), g = await f.open();
  assert.match((await f.say(g, '当前项目')).text, /Alpha/);
  assert.match((await f.say(g, '当前 Agent')).text, /甲会话/);
  assert.match((await f.say(g, '列出 Agent')).text, /乙会话/);
  await f.say(g, '选择二');
  assert.equal((await f.say(g, '测试甲')).text, 'a2');
  await f.say(g, '列出项目'); await f.say(g, '选择 2');
  assert.match((await f.say(g, '测试未选 Agent')).text, /先.*Agent/);
  await f.say(g, '列出 Agent'); await f.say(g, '选择 1');
  assert.equal((await f.say(g, '测试乙')).text, 'b1');
  assert.deepEqual(f.sent.map(x => x.id), ['a2', 'b1']);
  assert.ok(f.sent.every(x => x.preserveConfig), 'existing Codex settings must be preserved');
});

test('voice creation is blocked locally in direct Codex navigation without sending or creating a thread', async () => {
  const f = fixture(), gateway = await f.open();
  assert.match((await f.say(gateway, '新建对话测试')).text, /Paseo模式/);
  assert.equal(f.sent.length, 0);
});

test('selection survives restart but old numbers and old requests cannot select or resend', async () => {
  const f = fixture(), g = await f.open();
  await f.say(g, '列出 Agent'); await f.say(g, '选择 2');
  await f.say(g, '测试', 'original');
  const restored = await f.open();
  assert.match((await f.say(restored, '当前 Agent')).text, /乙会话/);
  assert.match((await f.say(restored, '选择 1')).text, /先.*列出/);
  assert.equal((await f.say(restored, '测试', 'original')).status, 'unknown');
  assert.equal(f.sent.length, 1);
});

test('stale lists and moved or deleted threads never receive a message', async () => {
  const f = fixture(), g = await f.open();
  await f.say(g, '列出 Agent');
  f.threads.splice(1, 1);
  assert.match((await f.say(g, '选择 2')).text, /变化|失效/);
  f.threads[0].cwd = 'C:\\Projects\\Moved';
  assert.match((await f.say(g, '不能发到其他项目')).text, /变化|不可用|重新/);
  assert.equal(f.sent.length, 0);
});

test('busy threads are listed but do not receive a new message', async () => {
  const f = fixture(), g = await f.open();
  f.threads[0].status = { type: 'active' };
  assert.match((await f.say(g, '测试')).text, /执行中|忙/);
  assert.equal(f.sent.length, 0);
});

test('numbering is local to each five-item page and never selects by name', async () => {
  const f = fixture();
  for (let i = 3; i <= 7; i++) f.threads.push({ id: 'a' + i, cwd: f.threads[0].cwd, name: '会话' + i, status: { type: 'idle' } });
  const g = await f.open();
  const first = (await f.say(g, '列出 Agent')).text;
  assert.match(first, /会话5/); assert.doesNotMatch(first, /会话6/);
  assert.match((await f.say(g, '下一页')).text, /1.*会话6/);
  await f.say(g, '选择一');
  assert.equal((await f.say(g, '测试')).text, 'a6');
  assert.match((await f.say(g, '选择 9')).text, /编号|列出/);
});

test('metadata catalog never uses preview text as a name or exposes conversation bodies', async () => {
  const f = fixture();
  f.threads[0].name = null; f.threads[0].preview = 'PRIVATE_BODY_NOT_A_TITLE';
  const g = await f.open();
  const result = await f.say(g, '列出 Agent');
  assert.doesNotMatch(result.text, /PRIVATE_BODY/);
  assert.match(result.text, /未命名/);
});

test('the host development conversation is excluded from glasses navigation', async () => {
  const { readThreadMetadata } = await import('./catalog.mjs');
  const rpc = { async request() { return { data: [
    { id: 'host-thread', cwd: 'C:\\Projects\\Alpha', name: '开发会话' },
    { id: 'idle-thread', cwd: 'C:\\Projects\\Alpha', name: '空闲会话' },
  ] }; } };
  const result = await readThreadMetadata(rpc, undefined, { excludeIds: ['host-thread'] });
  assert.deepEqual(result.map(t => t.id), ['idle-thread']);
});

test('an occupied conversation never receives the question and prompts choosing a closed session', async () => {
  const f = fixture({ resumeError: 'THREAD_IN_USE' }), g = await f.open();
  const result = await f.say(g, '请概括之前的内容');
  assert.match(result.text, /另一.*打开|另一.*占用/);
  assert.match(result.text, /未发送/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.data.requests.at(-1).errorCode, 'THREAD_IN_USE');
});

test('recent controls explicitly report unsupported user-time sorting without reading or sending', async () => {
  const f = fixture(), g = await f.open();
  const selection = structuredClone(f.state.data.selection);
  f.rpc.request = async () => { assert.fail('unsupported recent control must not read threads'); };
  for (const text of ['最近对话', '列出最近对话', '请帮我列出最近对话。']) {
    const result = await f.say(g, text);
    assert.equal(result.status, 'control');
    assert.match(result.text, /Codex暂不支持按最后发言时间列出最近对话/);
    assert.match(result.text, /列出Agent/);
  }
  assert.deepEqual(f.state.data.selection, selection);
  assert.equal(f.sent.length, 0);
  assert.ok(f.state.data.requests.every(r => r.kind === 'control'));
});

test('Codex app-server invalidation rejects a list that finishes after the connection changed', async () => {
  const f = fixture(), g = await f.open();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const request = f.rpc.request;
  f.rpc.request = async (method, args) => { const value = await request(method, args); if (method === 'thread/list') { enter(); await waiting; } return value; };
  const pending = f.say(g, '列出项目'); await entered;
  g.invalidateListing(); release();
  assert.doesNotMatch((await pending).text, /1\./);
  f.rpc.request = request;
  assert.match((await f.say(g, '选择 1')).text, /先.*列出/);
  assert.equal(f.sent.length, 0);
});
