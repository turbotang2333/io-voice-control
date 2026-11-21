import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../bridge/conversation-search.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
function fixture() {
  const workspaces = [
    { id: 'w', title: 'projectbeta', project: { projectKey: 'p' } },
    { id: 'x', title: 'projectgamma', project: { projectKey: 'px' } },
    { id: 'gone', title: '已归档', archivedAt: 'now', project: { projectKey: 'pg' } },
  ];
  const agents = [
    { id: 'a', workspaceId: 'w', title: '方案讨论', provider: 'codex', status: 'closed', updatedAt: '1' },
    { id: 'b', workspaceId: 'x', title: '社媒运营', provider: 'codex', status: 'idle', updatedAt: '1' },
    { id: 'archived', workspaceId: 'w', title: '安卓推送', archivedAt: 'now' },
    { id: 'hidden', workspaceId: 'gone', title: '安卓推送' },
    { id: 'internal', workspaceId: 'w', title: '安卓推送', internal: true },
  ];
  const bodies = { a: ['这是一份关于安卓 APP 推送及通知权限的方案。'], b: ['绘制用于社交媒体宣传的图片。'] };
  const reads = [], embedded = [];
  const embed = async texts => { embedded.push(...texts); return texts.map(text => /(?:推送|通知|提醒)/.test(text) ? [1, 0] : /(?:图片|生图|社媒)/.test(text) ? [0, 1] : [0.3, 0.3]); };
  const client = {
    workspaces: { list: async () => ({ entries: workspaces, pageInfo: {} }) },
    agents: { list: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: {} }),
      ref: id => ({ refresh: async () => ({ agent: agents.find(a => a.id === id) }) }) },
  };
  const history = { read: async agent => { reads.push(agent.id); return { messages: bodies[agent.id] ?? [], complete: true }; }, close: async () => {} };
  return { workspaces, agents, bodies, reads, embedded, embed, client, history };
}

test('project aliases belong to each installation and never ship as another users project names', async () => {
  const f = fixture();
  const scoped = api.createConversationSearch(f.client, { history: f.history, embed: f.embed,
    projectAliases: { 'projectbeta': ['我的示例工作区'] } });
  try {
    const result = await scoped.search('我的示例工作区项目里的安卓推送', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a'); assert.deepEqual([...new Set(f.reads)], ['a']);
  } finally { await scoped.close(); }
});

test('interactive title matches return without reading bodies or waiting for the embedding model', async () => {
  const f = fixture(); f.agents[0].title = '眼镜新建验证 2026-11-08';
  let bodyReads = 0, modelCalls = 0;
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, titleFirst: true, indexBudgetMs: 30,
    history: { async read() { bodyReads++; throw Error('body unavailable'); } },
    embed: async () => { modelCalls++; return []; } });
  try {
    const result = await search.search('眼镜新建验证', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a');
    assert.equal(result.coverage, 'partial'); assert.equal(result.items[0].bodyCoverage, 'title-only');
    assert.equal(bodyReads, 0); assert.equal(modelCalls, 0);
    const target = await search.resolve({ snapshot: result, itemIndex: 0, scopeKey: 's' });
    assert.equal(target.agentId, 'a');
  } finally { await search.close(); }
});

test('interactive search returns partial keyword results when a body read never completes', async () => {
  const f = fixture(); f.agents[0].title = '安卓权限方案';
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, indexBudgetMs: 30,
    history: { read: () => new Promise(() => {}), close() {} }, embed: async () => [] });
  try {
    const result = await search.search('示例工作台 安卓推送', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a'); assert.equal(result.coverage, 'partial');
    assert.equal(result.semanticAvailable, false);
  } finally { await search.close(); }
});

test('interactive keyword bodies remain searchable when semantic model loading stalls', async () => {
  const f = fixture();
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, indexBudgetMs: 30, history: f.history,
    embed: () => new Promise(() => {}) });
  try {
    const result = await search.search('示例工作台 安卓推送', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a'); assert.equal(result.semanticAvailable, false);
    assert.equal(result.coverage, 'partial');
  } finally { await search.close(); }
});

test('budget exhaustion cannot publish old bodies skipped by a cache-disabled refresh', async () => {
  const f = fixture(); f.agents[1].workspaceId = 'w'; f.bodies.b = ['安卓推送'];
  let stalled = false;
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, indexBudgetMs: 60, cacheMs: 0, embed: f.embed,
    history: { read: agent => stalled && agent.id === 'a' ? new Promise(() => {}) : f.history.read(agent), close() {} } });
  try {
    assert.ok((await search.search('示例工作台 安卓推送', { scopeKey: 's' })).items.some(i => i.agentId === 'b'));
    stalled = true; f.bodies.b = ['正文已改变，时间戳没有变化'];
    const result = await search.search('示例工作台 安卓推送', { scopeKey: 's' });
    assert.equal(result.items.some(i => i.agentId === 'b'), false); assert.equal(result.coverage, 'partial');
  } finally { await search.close(); }
});

test('timed out embedding inference cannot accumulate new background batches on repeated searches', async () => {
  const f = fixture(); let release, active = 0, peak = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const embed = async texts => {
    if (!texts.length) return [];
    active++; peak = Math.max(peak, active);
    try { await gate; return f.embed(texts); } finally { active--; }
  };
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, indexBudgetMs: 30, history: f.history, embed });
  try {
    await search.search('示例工作台 安卓推送', { scopeKey: 's' });
    await search.search('示例工作台 通知', { scopeKey: 's' });
    assert.equal(peak, 1);
  } finally { release(); await search.close(); }
});
test('Chinese project aliases scope body search and never read archived, internal or other projects', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture();
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  const result = await search.search('示例工作台安卓 APP 推送相关的对话', { scopeKey: 's' });
  assert.deepEqual(result.items.map(i => i.agentId), ['a']);
  assert.deepEqual(f.reads, ['a']); assert.equal(result.coverage, 'complete');
  const target = await search.resolve({ snapshot: result, itemIndex: 0, scopeKey: 's' });
  assert.equal(target.workspaceId, 'w'); assert.equal(target.agentId, 'a'); await search.close();
});
test('meaning matches bodies without query keywords, while unknown explicit projects and unrelated queries do not select', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture();
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  assert.equal((await search.search('示例工作台手机提醒', { scopeKey: 's' })).items[0].agentId, 'a');
  const unknown = await search.search('不存在项目里面关于通知', { scopeKey: 's' });
  assert.equal(unknown.items.length, 0); assert.equal(unknown.reason, 'unknown-project');
  const empty = await search.search('关于的相关对话', { scopeKey: 's' });
  assert.equal(empty.reason, 'empty-query'); await search.close();
});
test('updates re-embed changed chunks only and new conversations become searchable on next query', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture();
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  await search.search('示例工作台推送', { scopeKey: 's' });
  const bodyCount = () => f.embedded.filter(t => t === f.bodies.a[0]).length;
  assert.equal(bodyCount(), 1);
  f.agents[0].updatedAt = '2'; f.bodies.a.push('新增的一段系统通知说明。');
  await search.search('示例工作台通知', { scopeKey: 's' }); assert.equal(bodyCount(), 1);
  f.agents.push({ id: 'new', workspaceId: 'w', title: '安卓推送新方案', provider: 'codex', status: 'closed', updatedAt: '1' });
  f.bodies.new = ['新的推送内容'];
  assert.ok((await search.search('示例工作台安卓推送新方案', { scopeKey: 's' })).items.some(i => i.agentId === 'new'));
  await search.close();
});
test('search selection rechecks archive and workspace scope and rejects forged, foreign and expired lists', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture(); let now = 1000;
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed, now: () => now });
  const snapshot = await search.search('示例工作台推送', { scopeKey: 's' });
  await assert.rejects(search.resolve({ snapshot: { ...snapshot }, itemIndex: 0, scopeKey: 's' }), { code: 'SEARCH_STALE' });
  await assert.rejects(search.resolve({ snapshot, itemIndex: 0, scopeKey: 'other' }), { code: 'SEARCH_STALE' });
  f.agents[0].archivedAt = 'now';
  await assert.rejects(search.resolve({ snapshot, itemIndex: 0, scopeKey: 's' }), { code: 'SEARCH_STALE' });
  assert.equal((await search.search('示例工作台推送', { scopeKey: 's' })).items.length, 0);
  delete f.agents[0].archivedAt; now = 999999;
  await assert.rejects(search.resolve({ snapshot, itemIndex: 0, scopeKey: 's' }), { code: 'SEARCH_STALE' }); await search.close();
});
test('failed or unsupported body reads retain titles with partial coverage instead of old body claims', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture();
  f.agents[0].title = '安卓推送'; f.agents[0].provider = 'other';
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: { read() { throw new Error('private'); }, close() {} }, embed: f.embed });
  const result = await search.search('示例工作台安卓推送', { scopeKey: 's' });
  assert.equal(result.coverage, 'partial'); assert.equal(result.items[0].bodyCoverage, 'title-only');
  await search.close();
});
test('removal during history loading excludes results and stale navigation cannot publish after indexing', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture();
  f.history.read = async agent => { f.agents[0].archivedAt = 'now'; return { messages: f.bodies.a, complete: true }; };
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  assert.equal((await search.search('示例工作台推送', { scopeKey: 's' })).items.length, 0);
  await assert.rejects(search.search('示例工作台推送', { scopeKey: 's', assertCurrent() { throw new Error('stale'); } }));
  await search.close();
});

test('a recovered model embeds previously missing unchanged chunks before claiming semantic coverage', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture(); let offline = true;
  const embed = async texts => { if (offline) throw new Error('model temporarily unavailable'); return f.embed(texts); };
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed });
  const first = await search.search('示例工作台推送', { scopeKey: 's' }); assert.equal(first.semanticAvailable, false);
  offline = false;
  const next = await search.search('示例工作台手机提醒', { scopeKey: 's' });
  assert.equal(next.semanticAvailable, true); assert.equal(next.items[0]?.agentId, 'a'); await search.close();
});

test('a caller can disable body caching when native metadata timestamps have only second precision', async () => {
  const f = fixture();
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed, cacheMs: 0 });
  try {
    await search.search('示例工作台安卓推送', { scopeKey: 's' });
    f.bodies.a = ['部署 Kubernetes 服务网关。'];
    const result = await search.search('示例工作台 Kubernetes', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a');
    assert.equal(f.reads.filter(id => id === 'a').length, 2);
  } finally { await search.close(); }
});

test('model or index limits label partial coverage instead of treating unindexed conversations as absent', async () => {
  assert.equal(typeof api.createConversationSearch, 'function'); const f = fixture();
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed, maxChunks: 1 });
  assert.equal((await search.search('示例工作台推送', { scopeKey: 's' })).coverage, 'partial');
  await search.close();
});

test('a later project name is query content and cannot widen the first project restriction', async () => {
  const f = fixture();
  f.workspaces[1].title = 'rayneo-paseo'; f.agents[0].title = f.agents[1].title = '雷鸟眼镜连接';
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  const result = await search.search('示例工作台里面关于雷鸟眼镜连接的对话', { scopeKey: 's' });
  assert.deepEqual(result.items.map(i => i.workspaceId), ['w']); assert.deepEqual(f.reads, ['a']);
  assert.ok(f.embedded.some(t => t.includes('雷鸟眼镜连接'))); await search.close();
});

test('an unknown explicit project fails before reading a known project mentioned in the topic', async () => {
  const f = fixture(); const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  const result = await search.search('不存在项目里面关于示例项目的社媒方案', { scopeKey: 's' });
  assert.equal(result.reason, 'unknown-project'); assert.deepEqual(f.reads, []); await search.close();
});

test('a conversation changed during indexing reports partial coverage rather than claiming it was fully searched', async () => {
  const f = fixture(); f.history.read = async agent => {
    agent.updatedAt = 'snapshot-must-not-be-mutated'; f.agents[0].updatedAt = '2';
    return { messages: f.bodies.a, complete: true };
  };
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  assert.equal((await search.search('示例工作台推送', { scopeKey: 's' })).coverage, 'partial'); await search.close();
});

test('closing search interrupts the reader before waiting for the pending query', async () => {
  const f = fixture(); let release, entered, historyClosed = false;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  f.history.read = async () => { entered(); await held; return { messages: [], complete: true }; };
  f.history.close = async () => { historyClosed = true; release(); };
  const search = api.createConversationSearch(f.client, { projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] }, history: f.history, embed: f.embed });
  const reading = search.search('示例工作台推送', { scopeKey: 's' });
  const rejected = assert.rejects(reading);
  await started; const closing = search.close();
  await new Promise(r => setImmediate(r));
  const immediate = historyClosed; release(); await closing; await rejected;
  assert.equal(immediate, true);
});
