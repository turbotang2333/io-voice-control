import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecentConversations } from './recent.mjs';

function fixture() {
  const catalog = { projects: [{ id: 'p1', name: '项目一' }, { id: 'p2', name: '项目二' }],
    threads: [{ id: 'a', name: '对话甲', projectId: 'p1', updatedAt: 999999 },
      { id: 'b', name: '对话乙', projectId: 'p2' }, { id: 'empty', name: '空对话', projectId: 'p1' }] };
  const pages = new Map([
    ['a', { data: [{ items: [{ type: 'userMessage', startedAtMs: 1000 },
      { type: 'agentMessage', startedAtMs: 900000 }] }], nextCursor: null }],
    ['b', { data: [{ items: [{ type: 'userMessage', startedAtMs: 2000 }] }], nextCursor: null }],
    ['empty', { data: [], nextCursor: null }],
  ]);
  const reads = [];
  return { catalog, pages, reads, client: { async userTimePage(id, cursor) {
    reads.push({ id, cursor }); const value = pages.get(cursor ? `${id}:${cursor}` : id);
    if (value instanceof Error) throw value; return structuredClone(value);
  } } };
}

test('recent conversations sort across projects by user item time, never assistant output or thread updates', async () => {
  const f = fixture(); const result = await readRecentConversations(f.client, f.catalog);
  assert.deepEqual(result.items.map(i => i.id), ['b', 'a']);
  assert.equal(result.items[0].projectName, '项目二');
  assert.equal(result.partial, false);
});

test('missing newest user time omits a conversation instead of using an older user or updated time', async () => {
  const f = fixture();
  f.pages.set('b', { data: [{ items: [{ type: 'userMessage', startedAtMs: null }] },
    { items: [{ type: 'userMessage', startedAtMs: 900000 }] }], nextCursor: null });
  const result = await readRecentConversations(f.client, f.catalog);
  assert.deepEqual(result.items.map(i => i.id), ['a']); assert.equal(result.partial, true);
});

test('history pagination skips automatic turns and finds the most recent actual user input', async () => {
  const f = fixture();
  f.pages.set('a', { data: [{ items: [{ type: 'agentMessage', startedAtMs: 900000 }] }], nextCursor: 'older' });
  f.pages.set('a:older', { data: [{ items: [{ type: 'userMessage', startedAtMs: 3000 },
    { type: 'userMessage', startedAtMs: 4000 }] }], nextCursor: null });
  const result = await readRecentConversations(f.client, f.catalog);
  assert.deepEqual(result.items.map(i => i.id), ['a', 'b']); assert.equal(result.items[0].lastUserAt, 4000);
  assert.ok(f.reads.some(r => r.cursor === 'older'));
});

test('a read failure or cursor loop is explicitly partial and cannot create selectable stale entries', async () => {
  const f = fixture(); f.pages.set('b', new Error('private details must not be returned'));
  f.pages.set('a', { data: [], nextCursor: 'loop' }); f.pages.set('a:loop', { data: [], nextCursor: 'loop' });
  const result = await readRecentConversations(f.client, f.catalog);
  assert.deepEqual(result.items, []); assert.equal(result.partial, true);
  assert.doesNotMatch(JSON.stringify(result), /private details/);
});

test('a changed phone session aborts the recent read instead of becoming a partial success', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(readRecentConversations(f.client, f.catalog, { assertCurrent() {
    if (++calls > 1) throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' });
  } }), { code: 'NAVIGATION_SESSION_STALE' });
});
