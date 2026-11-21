import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorSearch } from './search.mjs';

function fixture() {
  const projects = [{ id: 'p1', name: 'projectbeta', roots: [{ path: 'C:\\personal' }] },
    { id: 'p2', name: 'projectgamma', roots: [{ path: 'C:\\images' }] }];
  const threads = [{ id: 'a', name: '讨论记录', projectId: 'p1', cwd: 'C:\\personal' },
    { id: 'b', name: '图片工作', projectId: 'p2', cwd: 'C:\\images' }];
  const bodies = new Map([['a', '安卓应用通知和推送权限方案'], ['b', '社交媒体图片生成设计']]);
  const reads = [], methods = []; let closed = false;
  const reader = { ready: false,
    async connect() { this.ready = true; }, async close() { this.ready = false; closed = true; },
    projectPage: async () => ({ data: structuredClone(projects), nextCursor: null }),
    threadPage: async () => ({ data: structuredClone(threads), nextCursor: null }),
    bindThread(id) { return { snapshot: async () => structuredClone(threads.find(t => t.id === id)) }; },
    async request(method, params) {
      methods.push(method); assert.equal(method, 'thread/turns/list'); reads.push(params.threadId);
      return { data: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: bodies.get(params.threadId) }] }] }], nextCursor: null };
    },
  };
  const embed = async texts => texts.map(text => /通知|推送|提醒/.test(text) ? [1, 0] : /图片|生图|社媒/.test(text) ? [0, 1] : [0.1, 0.1]);
  const search = createConnectorSearch({}, { readerFactory(options) { assert.equal(options.readOnly, true); return reader; }, embed,
    projectAliases: { 'projectbeta': ['示例工作台', '示例系统'], projectgamma: ['示例项目'] } });
  return { search, threads, bodies, reads, methods, get closed() { return closed; } };
}

test('Codex search reuses local keyword and semantic retrieval with project aliases and no task methods', async () => {
  const f = fixture();
  try {
    const result = await f.search.search('示例工作台手机提醒', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a'); assert.equal(result.coverage, 'complete');
    assert.deepEqual(f.reads, ['a']);
    assert.doesNotMatch(JSON.stringify(result), /安卓应用通知和推送权限方案/);
    const selected = await f.search.resolve({ snapshot: result, itemIndex: 0, scopeKey: 's' });
    assert.equal(selected.workspaceId, 'p1');
    assert.ok(f.methods.every(m => m === 'thread/turns/list'));
  } finally { await f.search.close(); }
  assert.equal(f.closed, true);
});

test('a conversation removed or moved after searching cannot be selected from its old scope', async () => {
  const f = fixture();
  try {
    const result = await f.search.search('示例工作台通知', { scopeKey: 's' });
    f.threads[0].projectId = 'p2'; f.threads[0].cwd = 'C:\\images';
    await assert.rejects(f.search.resolve({ snapshot: result, itemIndex: 0, scopeKey: 's' }), { code: 'SEARCH_STALE' });
  } finally { await f.search.close(); }
});

test('new body content is searchable even when Codex metadata timestamps do not change', async () => {
  const f = fixture();
  try {
    await f.search.search('示例工作台通知', { scopeKey: 's' });
    f.bodies.set('a', 'Kubernetes 资源部署实践');
    const result = await f.search.search('示例工作台 Kubernetes', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a'); assert.equal(f.reads.length, 2);
  } finally { await f.search.close(); }
});

test('closing the search helper does not close or send through the main queue client', async () => {
  const source = { close() { throw new Error('main client must remain alive'); }, enqueue() { throw new Error('must not send'); } };
  const search = createConnectorSearch(source, { readerFactory() { throw new Error('unused reader must stay lazy'); }, embed: async () => [] });
  await search.close();
  await assert.rejects(search.search('任意主题', { scopeKey: 's' }), { code: 'SEARCH_CLOSED' });
});

test('an expired interactive body read cannot keep paging through native history in the background', async () => {
  let release, reads = 0;
  const page = new Promise(resolve => { release = resolve; });
  const thread = { id: 'a', name: '安卓权限', projectId: 'p', cwd: 'C:\\personal' };
  const reader = { ready: false, async connect() { this.ready = true; }, async close() { this.ready = false; },
    projectPage: async () => ({ data: [{ id: 'p', name: 'projectbeta', roots: [{ path: 'C:\\personal' }] }], nextCursor: null }),
    threadPage: async () => ({ data: [thread], nextCursor: null }),
    bindThread: () => ({ snapshot: async () => thread }),
    async request(method) { assert.equal(method, 'thread/turns/list'); reads++; return page; },
  };
  const search = createConnectorSearch({}, { readerFactory: () => reader, indexBudgetMs: 30, embed: async () => [] });
  try {
    const result = await search.search('示例工作台 安卓推送', { scopeKey: 's' });
    assert.equal(result.items[0]?.agentId, 'a'); assert.equal(result.coverage, 'partial');
    release({ data: [{ items: [] }], nextCursor: 'more-pages' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
  } finally { release({ data: [], nextCursor: null }); await search.close(); }
});
