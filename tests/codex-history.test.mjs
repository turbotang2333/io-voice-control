import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../bridge/codex-history.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e;
});
const agent = { id: 'paseo-a', provider: 'codex', cwd: process.cwd(),
  persistence: { provider: 'codex', sessionId: 'native-a' } };
const turn = { items: [
  { type: 'userMessage', content: [{ type: 'inputText', text: '安卓通知送达' }, { type: 'inputImage', imageUrl: 'private-image' }] },
  { type: 'commandExecution', aggregatedOutput: '不得检索工具输出' },
  { type: 'agentMessage', text: '推送需要系统授权。' },
] };
test('closed Codex history uses only read calls, paginates and excludes tools and attachments', async () => {
  assert.equal(typeof api.createCodexHistoryReader, 'function');
  const calls = [];
  const reader = api.createCodexHistoryReader({ request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: { id: 'native-a', cwd: process.cwd(), updatedAt: 3 } };
    return params.cursor ? { data: [{ items: [{ type: 'agentMessage', text: '末尾内容' }] }], nextCursor: null }
      : { data: [turn], nextCursor: 'older' };
  } });
  const result = await reader.read(agent);
  assert.deepEqual(result.messages, ['安卓通知送达', '推送需要系统授权。', '末尾内容']);
  assert.equal(result.complete, true);
  assert.deepEqual(calls.map(c => c[0]), ['thread/read', 'thread/turns/list', 'thread/turns/list']);
  assert.equal(calls[1][1].itemsView, 'full');
  assert.equal(calls[2][1].cursor, 'older');
  await reader.close();
});
test('old Codex fallback is read-only and used only for an unsupported pagination method', async () => {
  assert.equal(typeof api.createCodexHistoryReader, 'function');
  const calls = [];
  const reader = api.createCodexHistoryReader({ request: async (method, params) => {
    calls.push(method);
    if (method === 'thread/turns/list') throw Object.assign(new Error('unsupported'), { rpcCode: -32601 });
    return { thread: { id: 'native-a', cwd: process.cwd(), ...(params.includeTurns ? { turns: [turn] } : {}) } };
  } });
  assert.equal((await reader.read(agent)).messages.length, 2);
  assert.deepEqual(calls, ['thread/read', 'thread/turns/list', 'thread/read']);
  await reader.close();
});

test('native user text content is included in searchable history, without attachment text', async () => {
  const reader = api.createCodexHistoryReader({ request: async method => method === 'thread/read'
    ? { thread: { id: 'native-a', cwd: process.cwd() } }
    : { data: [{ items: [{ type: 'userMessage', content: [
      { type: 'text', text: '只有用户说过的身份验证细节', text_elements: [] },
      { type: 'image', text: '不得作为正文的附件描述' },
    ] }] }], nextCursor: null } });
  assert.deepEqual((await reader.read(agent)).messages, ['只有用户说过的身份验证细节']);
  await reader.close();
});
test('wrong native identity, wrong directory and repeated cursors fail closed', async () => {
  assert.equal(typeof api.createCodexHistoryReader, 'function');
  for (const thread of [{ id: 'other', cwd: process.cwd() }, { id: 'native-a', cwd: process.cwd() + '-other' }]) {
    const reader = api.createCodexHistoryReader({ request: async () => ({ thread }) });
    await assert.rejects(reader.read(agent), { code: 'SEARCH_HISTORY_FAILED' }); await reader.close();
  }
  const reader = api.createCodexHistoryReader({ request: async method => method === 'thread/read'
    ? { thread: { id: 'native-a', cwd: process.cwd() } } : { data: [turn], nextCursor: 'repeat' } });
  await assert.rejects(reader.read(agent), { code: 'SEARCH_HISTORY_FAILED' }); await reader.close();
});
test('timeouts do not fall back or expose upstream messages; bounded history reports partial', async () => {
  assert.equal(typeof api.createCodexHistoryReader, 'function');
  const methods = [];
  const reader = api.createCodexHistoryReader({ request: async method => {
    methods.push(method); if (method !== 'thread/read') throw new Error('secret upstream text');
    return { thread: { id: 'native-a', cwd: process.cwd() } };
  } });
  await assert.rejects(reader.read(agent), e => e.code === 'SEARCH_HISTORY_FAILED' && !e.message.includes('secret'));
  assert.deepEqual(methods, ['thread/read', 'thread/turns/list']); await reader.close();
  const bounded = api.createCodexHistoryReader({ maxCharacters: 3, request: async method => method === 'thread/read'
    ? { thread: { id: 'native-a', cwd: process.cwd() } } : { data: [turn], nextCursor: null } });
  assert.equal((await bounded.read(agent)).complete, false); await bounded.close();
});

test('closing a history reader cancels pagination and rejects any later read', async () => {
  let pages = 0, entered, release;
  const started = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const reader = api.createCodexHistoryReader({ request: async method => {
    if (method === 'thread/read') return { thread: { id: 'native-a', cwd: process.cwd() } };
    pages++; entered(); await held; return { data: [turn], nextCursor: pages < 10 ? String(pages) : null };
  } });
  const reading = reader.read(agent); const rejected = assert.rejects(reading, { code: 'SEARCH_HISTORY_FAILED' });
  await started; await reader.close(); release(); await rejected;
  assert.equal(pages, 1);
  await assert.rejects(reader.read(agent), { code: 'SEARCH_HISTORY_FAILED' });
});
