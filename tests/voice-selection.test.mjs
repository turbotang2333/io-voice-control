import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function fixture() {
  const sent = [];
  const workspaces = [
    { id: 'w1', title: '眼镜', project: { projectKey: 'p1' } },
    { id: 'w2', title: '写作', project: { projectKey: 'p2' } },
  ];
  const agents = [
    { id: 'a1', workspaceId: 'w1', title: '默认助手', status: 'idle' },
    { id: 'a2', workspaceId: 'w2', title: '文章助手', status: 'idle' },
    { id: 'a3', workspaceId: 'w2', title: '重名', status: 'idle' },
    { id: 'a4', workspaceId: 'w2', title: '重名', status: 'idle' },
  ];
  const client = {
    workspaces: { async list() { return { entries: workspaces, pageInfo: {} }; } },
    agents: {
      async list({ filter }) {
        assert.ok(filter.projectKeys?.length, 'agent queries must remain project scoped');
        return { entries: agents.map(agent => ({ agent })), pageInfo: {} };
      },
      ref(id) { let listener; return {
        timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
        async refresh() { return { agent: agents.find(a => a.id === id) }; },
        async run(text, options) {
          listener({ agentId: id, event: { type: 'timeline', turnId: 'test-turn', item: { type: 'user_message', messageId: options.messageId } } });
          sent.push({ id, text, requestId: options.messageId });
          return { status: 'idle', final: { id }, lastMessage: '已收到' };
        },
      }; },
    },
  };
  return { client, sent, workspaces, agents };
}

test('voice creation is a control, selects only the verified new target and never prompts the old Agent', async () => {
  const { createVoiceGateway, parseVoiceCommand } = await import('../bridge/voice-selection.mjs');
  const f = fixture(), created = [];
  assert.deepEqual(parseVoiceCommand('请帮我新建对话 Push test。'), { type: 'create', title: 'Push test' });
  assert.deepEqual(parseVoiceCommand('新建对话'), { type: 'create', title: '' });
  assert.equal(parseVoiceCommand('请解释新建对话的功能'), null);
  const creation = { supported: () => true, async create(value) {
    created.push(value);
    f.agents.push({ id: 'new1', workspaceId: 'w1', title: value.title, status: 'idle' });
    return { agentId: 'new1', workspaceId: 'w1', name: value.title, workspaceName: '眼镜' };
  } };
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', creation });
  assert.match((await gateway.submit({ requestId: 'empty-create', text: '新建对话' })).text, /补充名称/);
  assert.equal(created.length, 0);
  const result = await gateway.submit({ requestId: 'create-new', text: '新建对话推送调试' });
  assert.equal(result.status, 'control'); assert.match(result.text, /新对话已创建并选中/);
  assert.equal(created.length, 1); assert.equal(f.sent.length, 0);
  await gateway.submit({ requestId: 'create-new', text: '新建对话推送调试' });
  assert.equal(created.length, 1);
  await gateway.submit({ requestId: 'new-first', text: '确认后的首条问题' });
  assert.equal(f.sent.at(-1).id, 'new1');
});

test('unsupported creation and failed selection never send to the existing Agent or silently change selection', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  assert.match((await createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' })
    .submit({ requestId: 'unsupported-create', text: '新建对话推送调试' })).text, /不支持语音新建/);
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1',
    stateStore: { getSelection: () => null, reserveRequest() {}, findRequest: () => null, saveSelection() { throw Error('disk'); } },
    creation: { supported: () => true, create: async () => ({ agentId: 'new1', workspaceId: 'w1', name: '推送调试', workspaceName: '眼镜' }) },
  });
  assert.match((await gateway.submit({ requestId: 'create-select-fail', text: '新建对话推送调试' })).text, /已创建，但未能切换/);
  assert.match((await gateway.submit({ requestId: 'verify-old', text: '当前Agent' })).text, /默认助手/);
  assert.equal(f.sent.length, 0);
});

test('explicit search is a local control and numbered selection switches projects without sending', async () => {
  const { createVoiceGateway, parseVoiceCommand } = await import('../bridge/voice-selection.mjs');
  const { createConversationSearch } = await import('../bridge/conversation-search.mjs');
  assert.equal(parseVoiceCommand('请帮我查找对话 写作项目里面文章。')?.type, 'search');
  assert.equal(parseVoiceCommand('请解释查找对话这句话'), null);
  const f = fixture(); f.agents.forEach(a => { a.provider = 'codex'; });
  const search = createConversationSearch(f.client, { history: { read: async () => ({ messages: [], complete: true }) },
    embed: async texts => texts.map(() => [0, 0]) });
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', search });
  assert.match((await gateway.submit({ requestId: 's', text: '查找对话写作项目里面文章' })).text, /文章助手/);
  assert.equal(f.sent.length, 0);
  assert.match((await gateway.submit({ requestId: 'pick-s', text: '选择1' })).text, /已选择 Agent.*文章助手/);
  assert.equal(f.sent.length, 0);
  await gateway.submit({ requestId: 'new-q', text: '确认过的普通问题' }); assert.equal(f.sent.at(-1).id, 'a2');
  await search.close();
});

test('search controls without a configured search service never fall through to an Agent', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs'); const f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  assert.match((await gateway.submit({ requestId: 'empty-search', text: '查找对话' })).text, /查找|搜索/);
  assert.equal(f.sent.length, 0);
});

test('search announces progress before retrieval finishes and not for bare or unsupported searches', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const { createConversationSearch } = await import('../bridge/conversation-search.mjs');
  const f = fixture(), updates = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const search = createConversationSearch(f.client, { history: { read: async () => ({ messages: [], complete: true }) },
    embed: async texts => { await held; return texts.map(() => [0, 0]); } });
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', search });
  const onUpdate = item => updates.push(item);
  await gateway.submit({ requestId: 'bare-progress', text: '查找对话', onUpdate });
  assert.deepEqual(updates, []);
  const pending = gateway.submit({ requestId: 'search-progress', text: '查找对话文章', onUpdate });
  await new Promise(resolve => setImmediate(resolve));
  const early = [...updates]; release();
  const result = await pending;
  await search.close();
  assert.deepEqual(early, [{ type: 'state', state: 'searching' }]);
  assert.equal(result.status, 'control');
  assert.equal(f.sent.length, 0);
  updates.length = 0;
  await createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' })
    .submit({ requestId: 'unsupported-progress', text: '查找对话文章', onUpdate });
  assert.deepEqual(updates, []);
});

test('recognized 查询对话 alias stays on the search path, including a split prefix and an empty topic', async t => {
  const { createVoiceGateway, parseVoiceCommand } = await import('../bridge/voice-selection.mjs');
  const { createConversationSearch } = await import('../bridge/conversation-search.mjs');
  const f = fixture();
  const search = createConversationSearch(f.client, { history: { read: async () => ({ messages: [], complete: true }) },
    embed: async texts => texts.map(() => [0, 0]) });
  t.after(() => search.close());
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', search });
  for (const [index, text] of ['查询对话', '查询对话写作项目里面文章', '请帮我查询对话，写作项目，文章。'].entries()) {
    assert.equal(parseVoiceCommand(text)?.type, 'search');
    const result = await gateway.submit({ requestId: `alias-${index}`, text });
    assert.equal(result.status, 'control');
    assert.match(result.text, index === 0 ? /加上项目名或大致主题/ : /文章助手/);
  }
  assert.equal(f.sent.length, 0);
  assert.equal(parseVoiceCommand('请解释查询对话这个功能'), null);
});

test('search results invalidated during loading or before choosing cannot change selection', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const { createConversationSearch } = await import('../bridge/conversation-search.mjs'); const f = fixture();
  f.agents.forEach(a => { a.provider = 'codex'; });
  const search = createConversationSearch(f.client, { history: { read: async () => ({ messages: [], complete: true }) },
    embed: async texts => texts.map(() => [0, 0]) });
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', search });
  await gateway.submit({ requestId: 'list-s', text: '查找对话文章' }); f.agents[1].archivedAt = 'now';
  assert.doesNotMatch((await gateway.submit({ requestId: 'bad-pick', text: '选择1' })).text, /已选择/);
  assert.equal(f.sent.length, 0);
  assert.match((await gateway.submit({ requestId: 'still-current', text: '当前Agent' })).text, /默认助手/);
  await search.close();
});

async function persistent(t) {
  const { createStateStore } = await import('../bridge/state-store.mjs');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'selection.json');
  return { path, open: () => createStateStore(path) };
}

test('a fresh daily profile requires an explicit numbered selection before any message can be sent', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  const gateway = createVoiceGateway(f.client, { allowUnselected: true });
  assert.match((await gateway.submit({ requestId: 'no-default', text: '正文' })).text, /先选择项目/);
  await gateway.submit({ requestId: 'list', text: '列出项目' });
  await gateway.submit({ requestId: 'pick', text: '选择 1' });
  await gateway.submit({ requestId: 'agents', text: '列出 Agent' });
  await gateway.submit({ requestId: 'agent', text: '选择 1' });
  await gateway.submit({ requestId: 'question', text: '已确认目标的正文' });
  assert.deepEqual(f.sent, [{ id: 'a1', text: '已确认目标的正文', requestId: 'question' }]);
});

test('restart restores the chosen project and agent but never restores a numbered list', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  const open = () => createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  let gateway = open();
  for (const [requestId, text] of [['l1', '列出项目'], ['s1', '选择 2'], ['l2', '列出 Agent'], ['s2', '选择 1']]) {
    await gateway.submit({ requestId, text });
  }
  gateway = open();
  assert.match((await gateway.submit({ requestId: 'restored', text: '当前 Agent' })).text, /文章助手/);
  assert.match((await gateway.submit({ requestId: 'stale-list', text: '选择 2' })).text, /先.*列出/);
  await gateway.submit({ requestId: 'new-question', text: '只发送给恢复的会话' });
  assert.equal(f.sent.at(-1).id, 'a2');
});

test('restart between project and agent selection does not silently select a default agent', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  let gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  await gateway.submit({ requestId: 'list', text: '列出项目' });
  await gateway.submit({ requestId: 'switch', text: '选择 2' });
  gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  assert.match((await gateway.submit({ requestId: 'unselected', text: '测试正文' })).text, /先选择 Agent/);
  assert.equal(f.sent.length, 0);
});

test('restarted bridge blocks an old request even after the selected target changes without storing text', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  let gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  const input = { requestId: 'once', text: '不得落盘的原始问题' };
  await gateway.submit(input);
  gateway = createVoiceGateway(f.client, { agentId: 'a2', workspaceId: 'w2', stateStore: state.open() });
  assert.equal((await gateway.submit(input)).status, 'unknown');
  await assert.rejects(gateway.submit({ ...input, text: '另一问题' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(readFileSync(state.path, 'utf8'), /不得落盘|已收到/);
});

test('a failed selection write leaves the previous target selected and does not claim success', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  const stateStore = { getSelection: () => null, findRequest: () => null, reserveRequest() {}, saveSelection: () => { throw new Error('disk full'); } };
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore });
  await gateway.submit({ requestId: 'list', text: '列出项目' });
  assert.doesNotMatch((await gateway.submit({ requestId: 'switch', text: '选择 2' })).text, /已选择项目/);
  assert.match((await gateway.submit({ requestId: 'current', text: '当前项目' })).text, /眼镜/);
});

test('a moved restored agent is rejected before sending and cleared from persistent selection', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  state.open().saveSelection({ workspaceId: 'w1', agentId: 'a1' });
  f.agents[0].workspaceId = 'w2';
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  assert.match((await gateway.submit({ requestId: 'check', text: '当前 Agent' })).text, /变化/);
  assert.deepEqual(state.open().getSelection(), { workspaceId: 'w1' });
  assert.equal(f.sent.length, 0);
});

test('an archived restored project cannot receive a message even if its agent snapshot still exists', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  state.open().saveSelection({ workspaceId: 'w1', agentId: 'a1' });
  f.workspaces[0].archivedAt = '2026-10-27T00:00:00.000Z';
  const gateway = createVoiceGateway(f.client, { allowUnselected: true, stateStore: state.open() });
  const reply = await gateway.submit({ requestId: 'archived-project', text: '不应提交的正文' });
  assert.equal(reply.status, 'control');
  assert.match(reply.text, /项目.*不可用|重新选择项目/);
  assert.equal(f.sent.length, 0);
});

test('a daily bridge keeps serving controls beyond the old in-memory session limit', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  for (let i = 0; i < 300; i++) {
    const result = await gateway.submit({ requestId: `control-${i}`, text: '当前项目' });
    assert.match(result.text, /眼镜/);
  }
  assert.equal(f.sent.length, 0);
});

test('a daily bridge handles more than 128 turns without losing old request fingerprints', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  const original = { requestId: 'original', text: '真实正文' };
  await gateway.submit(original);
  for (let i = 0; i < 140; i++) {
    assert.equal((await gateway.submit({ requestId: `turn-${i}`, text: '新的请求' })).status, 'idle');
  }
  for (let i = 0; i < 300; i++) await gateway.submit({ requestId: `navigation-${i}`, text: '当前项目' });
  assert.equal((await gateway.submit(original)).status, 'unknown');
  assert.equal(f.sent.length, 141, 'an evicted memory entry must never become another model send');
});

test('a selection command cannot be replayed against a different list after restart', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const state = await persistent(t), f = fixture();
  let gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore: state.open() });
  await gateway.submit({ requestId: 'projects', text: '列出项目' });
  await gateway.submit({ requestId: 'choose-project', text: '选择 2' });
  await gateway.submit({ requestId: 'agents', text: '列出 Agent' });
  await gateway.submit({ requestId: 'choose-agent-once', text: '选择 1' });
  gateway = createVoiceGateway(f.client, { allowUnselected: true, stateStore: state.open() });
  await gateway.submit({ requestId: 'new-project-list', text: '列出项目' });
  await gateway.submit({ requestId: 'choose-agent-once', text: '选择 1' });
  assert.match((await gateway.submit({ requestId: 'current-restored', text: '当前项目' })).text, /写作/);
  assert.equal(f.sent.length, 0);
});

test('Agent queries tolerate recognition spacing and numbers always follow the most recent list', async () => {
  const { createVoiceGateway, parseVoiceCommand } = await import('../bridge/voice-selection.mjs');
  for (const text of ['当前 Agent', '列出 agent。', '请帮我选择五', '选择 ６']) assert.ok(parseVoiceCommand(text));
  for (const text of ['选择文章', '选择助手默认助手', '当前助手', '请解释当前 Agent']) assert.equal(parseVoiceCommand(text), null);
  const f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const submit = (requestId, text) => gateway.submit({ requestId, text });
  assert.match((await submit('current-workspace', '当前项目')).text, /当前项目：眼镜/);
  assert.doesNotMatch((await submit('workspace-only', '当前项目')).text, /默认助手/);
  await submit('workspaces', '列出项目');
  await submit('agents', '列出 Agent');
  await submit('query', '当前项目'); // Read-only queries must not replace a displayed list.
  assert.match((await submit('range', '选择 2')).text, /编号|当前页/);
  assert.match((await submit('pick-agent', '选择 １')).text, /已选择 Agent：默认助手/);
  await submit('agents-again', '列出 Agent');
  await submit('workspaces-again', '列出项目');
  assert.match((await submit('pick-workspace', '选择二')).text, /已选择项目：写作/);
  assert.equal(f.sent.length, 0);
});

test('voice navigation selects a workspace and agent without sending its commands to an agent', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const submit = (requestId, text) => gateway.submit({ requestId, text });
  assert.match((await submit('list', '列出项目')).text, /1[.、]眼镜[\s\S]*2[.、]写作/);
  assert.match((await submit('workspace', '选择 2')).text, /写作/);
  assert.match((await submit('unselected', '普通问题')).text, /先选择 Agent/);
  assert.match((await submit('agents', '列出 Agent')).text, /文章助手/);
  assert.match((await submit('agent', '选择一')).text, /已选择 Agent：文章助手/);
  assert.equal(f.sent.length, 0);
  await submit('question', '真正的问题');
  assert.deepEqual(f.sent, [{ id: 'a2', text: '真正的问题', requestId: 'question' }]);
  await submit('back-list', '列出项目');
  await submit('back', '选择 1');
  await submit('default-list', '列出 Agent');
  await submit('default', '选择 1');
  // A retried request must stay bound to its original target after selection changes.
  await submit('question', '真正的问题');
  assert.equal(f.sent.length, 1);
});

test('numbers require the latest list, preserve duplicate names, and reject stale entries', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const submit = (requestId, text) => gateway.submit({ requestId, text });
  assert.match((await submit('no-list', '选择 1')).text, /先.*列出/);
  await submit('workspaces', '列出项目');
  await submit('w', '选择 2');
  assert.match((await submit('expired', '选择 1')).text, /先.*列出/);
  assert.match((await submit('duplicate', '列出 Agent')).text, /2[.]重名[\s\S]*3[.]重名/);
  assert.match((await submit('blocked', '普通问题')).text, /先选择 Agent/);
  f.agents.find(a => a.id === 'a3').workspaceId = 'moved';
  assert.match((await submit('stale', '选择 2')).text, /变化|重新列出/);
  assert.match((await submit('invalidated', '选择 1')).text, /先.*列出/);
  await submit('fresh', '列出 Agent');
  assert.match((await submit('duplicate-survivor', '选择 2')).text, /已选择 Agent：重名/);
  assert.equal((await submit('selected', '当前 Agent')).agentId, 'a4');
  assert.equal(f.sent.length, 0);
});

test('busy turns prevent a selection change and repeated controls remain idempotent', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  let finish;
  const originalRef = f.client.agents.ref;
  f.client.agents.ref = id => ({ ...originalRef(id), async run(text, options) {
    f.sent.push({ id, text, requestId: options.messageId });
    await new Promise(resolve => { finish = resolve; });
    return { status: 'idle', final: { id }, lastMessage: '完成' };
  } });
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const pending = gateway.submit({ requestId: 'running', text: '真实问题' });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.match((await gateway.submit({ requestId: 'switch', text: '选择 2' })).text, /执行中/);
  finish(); await pending;
  assert.match((await gateway.submit({ requestId: 'current', text: '当前 Agent' })).text, /默认助手/);
  await gateway.submit({ requestId: 'list-once', text: '列出项目' });
  await gateway.submit({ requestId: 'select-once', text: '选择 2' });
  await gateway.submit({ requestId: 'list-other', text: '列出项目' });
  await gateway.submit({ requestId: 'select-other', text: '选择 1' });
  await gateway.submit({ requestId: 'select-once', text: '选择 2' });
  assert.match((await gateway.submit({ requestId: 'still-eye', text: '当前项目' })).text, /眼镜/);
  assert.equal(f.sent.length, 1);
});

test('navigation paginates displayed numbers and keeps quoted command text as an ordinary question', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = fixture();
  for (let n = 3; n <= 8; n++) f.workspaces.push({ id: `w${n}`, title: `项目${n}`, project: { projectKey: `p${n}` } });
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const submit = (requestId, text) => gateway.submit({ requestId, text });
  assert.match((await submit('list', '列出项目')).text, /下一页/);
  assert.doesNotMatch((await submit('page', '下一页')).text, /默认助手/);
  assert.match((await submit('out-of-page', '选择 5')).text, /编号|当前页/);
  assert.match((await submit('select', '选择第一个')).text, /项目6/);
  await submit('back-list', '列出项目');
  await submit('back', '选择 1');
  await submit('default-list', '列出 Agent');
  await submit('default', '选择 1');
  await submit('body', '请解释“选择 1”是什么意思');
  assert.equal(f.sent.at(-1).text, '请解释“选择 1”是什么意思');
});

test('HTTP voice controls require authentication and return a displayable reply without model sends', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const { createRequestHandler } = await import('../bridge/http.mjs');
  const f = fixture();
  const gateway = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const server = createServer(createRequestHandler({ token: 'test-only-token', gateway }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'denied' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '选择 2' }], stream: true }) });
  assert.equal(denied.status, 401); await denied.text();
  const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-only-token', 'idempotency-key': 'list' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '列出 Agent' }], stream: true }) });
  assert.equal(response.status, 200);
  const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.at(-1).status, 'control');
  assert.match(frames.at(-1).text, /默认助手/);
  assert.doesNotMatch(frames.at(-1).text, /文章助手/);
  assert.equal(f.sent.length, 0);
});

function recentFixture() {
  const f = fixture();
  f.agents.forEach((agent, index) => { agent.lastUserMessageAt = `2026-10-29T0${index}:00:00Z`; });
  let sequence = 0;
  return { ...f, say: (gateway, text, requestId = `recent-${++sequence}`) => gateway.submit({ requestId, text }) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('recent commands are exact controls and list cross-project names without switching or sending', async () => {
  const { createVoiceGateway, parseVoiceCommand } = await import('../bridge/voice-selection.mjs');
  for (const text of ['最近对话', '列出最近对话', '请帮我列出最近对话。']) {
    assert.deepEqual(parseVoiceCommand(text), { type: 'recent' });
  }
  assert.equal(parseVoiceCommand('请解释最近对话的意思'), null);
  const f = recentFixture(), g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  f.agents[0].updatedAt = '2030-01-01T00:00:00Z';
  const reply = await f.say(g, '最近对话');
  assert.equal(reply.status, 'control');
  assert.match(reply.text, /1\.写作[：: ]+重名/);
  assert.match(reply.text, /4\.眼镜[：: ]+默认助手/);
  assert.equal((await f.say(g, '当前 Agent')).agentId, 'a1');
  assert.equal(f.sent.length, 0);
});

test('recent pages contain five entries and a number saves the cross-project pair exactly once', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), saves = [];
  for (let i = 5; i <= 7; i++) f.agents.push({ id: `a${i}`, workspaceId: 'w2', title: `会话${i}`,
    status: 'idle', lastUserMessageAt: `2026-10-29T0${i}:00:00Z` });
  const stateStore = { getSelection: () => null, findRequest: () => null, reserveRequest() {}, saveSelection: value => saves.push(value) };
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore });
  const first = await f.say(g, '列出最近对话');
  assert.equal(first.text.split('\n').filter(line => /^[1-5]\./.test(line)).length, 5);
  assert.doesNotMatch(first.text, /文章助手|默认助手/);
  assert.match((await f.say(g, '下一页')).text, /1\.写作：文章助手[\s\S]*2\.眼镜：默认助手/);
  assert.match((await f.say(g, '选择 3')).text, /当前页|编号/);
  assert.deepEqual(saves, []);
  assert.match((await f.say(g, '选择一')).text, /已选择 Agent：文章助手/);
  assert.deepEqual(saves, [{ workspaceId: 'w2', agentId: 'a2' }]);
  assert.equal(f.sent.length, 0);
  await f.say(g, '实际问题');
  assert.equal(f.sent.at(-1).id, 'a2');
});

test('partial and empty recent lists explain missing user times without updatedAt fallback', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), g = createVoiceGateway(f.client, { allowUnselected: true });
  f.agents[3].lastUserMessageAt = null;
  f.agents[3].title = '缺时间条目';
  assert.match((await f.say(g, '最近对话')).text, /缺少.*时间|部分/);
  assert.doesNotMatch((await f.say(g, '最近对话')).text, /缺时间条目/);
  for (const agent of f.agents) { agent.lastUserMessageAt = null; agent.updatedAt = '2030-01-01T00:00:00Z'; }
  assert.match((await f.say(g, '最近对话')).text, /暂无|没有/);
  assert.match((await f.say(g, '选择 1')).text, /当前页|编号|重新列出/);
  assert.equal(f.sent.length, 0);
});

test('new recent or ordinary lists replace old numbers and old request IDs cannot select again', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  await f.say(g, '最近对话');
  f.agents[1].lastUserMessageAt = '2026-10-29T12:00:00Z';
  await f.say(g, '最近对话');
  assert.match((await f.say(g, '选择 1', 'recent-pick-once')).text, /文章助手/);
  assert.equal((await f.say(g, '当前 Agent')).agentId, 'a2');
  await f.say(g, '最近对话');
  await f.say(g, '列出项目');
  assert.match((await f.say(g, '选择 1')).text, /已选择项目：眼镜/);
  await f.say(g, '最近对话');
  await f.say(g, '选择 1', 'recent-pick-once');
  assert.match((await f.say(g, '当前 Agent')).text, /先选择 Agent/);
  assert.equal(f.sent.length, 0);
});

test('failed cross-project persistence leaves the previous pair selected', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(); let writes = 0;
  const stateStore = { getSelection: () => null, findRequest: () => null, reserveRequest() {}, saveSelection() { writes++; throw new Error('disk full'); } };
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore });
  await f.say(g, '最近对话');
  assert.doesNotMatch((await f.say(g, '选择 1')).text, /已选择/);
  assert.equal(writes, 1);
  assert.equal((await f.say(g, '当前 Agent')).agentId, 'a1');
  assert.match((await f.say(g, '当前项目')).text, /眼镜/);
  assert.equal(f.sent.length, 0);
});

test('serial control gate rejects a second list while the first is reading', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), entered = deferred(), release = deferred();
  const list = f.client.agents.list;
  f.client.agents.list = async options => { entered.resolve(); await release.promise; return list(options); };
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const first = f.say(g, '最近对话'); await entered.promise;
  assert.match((await f.say(g, '列出项目')).text, /执行中/);
  release.resolve(); await first;
  assert.match((await f.say(g, '选择 1')).text, /已选择 Agent：重名/);
  assert.equal(f.sent.length, 0);
});

test('invalidating during a list read prevents the old response from publishing or reviving numbers', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), entered = deferred(), release = deferred();
  const list = f.client.agents.list;
  f.client.agents.list = async options => { entered.resolve(); await release.promise; return list(options); };
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const pending = f.say(g, '最近对话'); await entered.promise;
  assert.equal(typeof g.invalidateListing, 'function');
  g.invalidateListing(); release.resolve();
  assert.doesNotMatch((await pending).text, /最近对话[（(]|1\./);
  assert.match((await f.say(g, '选择 1')).text, /先.*列出|重新列出/);
  f.client.agents.list = list;
  assert.match((await f.say(g, '最近对话')).text, /1\./);
  assert.equal(f.sent.length, 0);
});

test('invalidating while resolving a recent choice prevents selection from being saved', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), entered = deferred(), release = deferred(), saves = [];
  const stateStore = { getSelection: () => null, findRequest: () => null, reserveRequest() {}, saveSelection: value => saves.push(value) };
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1', stateStore });
  await f.say(g, '最近对话');
  const ref = f.client.agents.ref;
  f.client.agents.ref = id => ({ ...ref(id), async refresh() { entered.resolve(); await release.promise; return ref(id).refresh(); } });
  const pending = f.say(g, '选择 1'); await entered.promise;
  g.invalidateListing();
  assert.match((await f.say(g, '最近对话')).text, /执行中/);
  release.resolve();
  assert.doesNotMatch((await pending).text, /已选择/);
  assert.deepEqual(saves, []);
  assert.equal((await f.say(g, '当前 Agent')).agentId, 'a1');
});

test('recent snapshots expire for paging and selection without changing the selected pair', async t => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(); let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  for (const command of ['下一页', '选择 1']) {
    await f.say(g, '最近对话'); clock += 120000;
    assert.match((await f.say(g, command)).text, /失效|重新列出/);
  }
  assert.equal((await f.say(g, '当前 Agent')).agentId, 'a1');
  assert.equal(f.sent.length, 0);
});

test('moved recent targets invalidate the list without switching or sending', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  await f.say(g, '最近对话'); f.agents[3].workspaceId = 'w1';
  assert.doesNotMatch((await f.say(g, '选择 1')).text, /已选择/);
  assert.match((await f.say(g, '选择 2')).text, /先.*列出|重新列出/);
  assert.equal((await f.say(g, '当前 Agent')).agentId, 'a1');
  assert.equal(f.sent.length, 0);
});

test('invalidating a list never cancels a real task or resets its request deduplication', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), entered = deferred(), release = deferred();
  const ref = f.client.agents.ref;
  f.client.agents.ref = id => { const handle = ref(id); return { ...handle, async run(text, options) {
    await handle.run(text, options); entered.resolve();
    await release.promise;
    return { status: 'idle', final: { id }, lastMessage: '完成' };
  } }; };
  const g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  const pending = f.say(g, '真实任务', 'real-task'); await entered.promise;
  g.invalidateListing();
  assert.match((await f.say(g, '最近对话')).text, /执行中/);
  release.resolve(); assert.equal((await pending).status, 'idle');
  assert.equal((await f.say(g, '真实任务', 'real-task')).status, 'idle');
  assert.equal(f.sent.length, 1);
  assert.match((await f.say(g, '最近对话')).text, /1\./);
});

test('a navigation read throwing a non-Error still returns a control reply without sending', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  const f = recentFixture(), g = createVoiceGateway(f.client, { agentId: 'a1', workspaceId: 'w1' });
  f.client.workspaces.list = async () => { throw null; };
  const result = await f.say(g, '列出项目');
  assert.equal(result.status, 'control');
  assert.match(result.text, /没有发送/);
  assert.equal(f.sent.length, 0);
});
