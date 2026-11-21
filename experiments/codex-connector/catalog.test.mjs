import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog, projectForThread } from './catalog.mjs';

test('uses registered project membership and groups older unassigned threads by directory', async () => {
  const client = {
    async projectPage() { return { data: [{ id: 'p1', name: '正式项目', roots: [{ path: 'C:\\alpha' }] }], nextCursor: null }; },
    async threadPage(cursor) {
      return cursor ? { data: [{ id: 'b', name: '旧对话', cwd: 'C:\\beta', projectId: null }], nextCursor: null }
        : { data: [{ id: 'a', name: '已有对话', cwd: 'C:\\alpha', projectId: 'p1' }], nextCursor: 'next' };
    },
  };
  const catalog = await readCatalog(client);
  assert.equal(catalog.projects.find(p => p.id === 'p1').name, '正式项目');
  const legacy = catalog.projects.find(p => p.name === 'beta');
  assert.ok(legacy); assert.equal(catalog.threads.find(t => t.id === 'b').projectId, legacy.id);
  assert.equal(catalog.threads.find(t => t.id === 'a').projectId, 'p1');
});

test('maps legacy directory membership only when there is one exact registered root', async () => {
  const c = { projectPage: async () => ({ data: [{ id: 'p1', name: 'A', roots: [{ path: 'C:\\alpha' }] }], nextCursor: null }),
    threadPage: async () => ({ data: [{ id: 'a', cwd: 'c:/ALPHA/', projectId: null }], nextCursor: null }) };
  const catalog = await readCatalog(c);
  assert.equal(catalog.threads[0].projectId, 'p1');
  assert.equal(projectForThread({ id: 'a', cwd: 'C:\\alpha', projectId: 'different' }, catalog), null);
});

test('unknown explicit membership and subagents are not silently reassigned', async () => {
  const c = { projectPage: async () => ({ data: [], nextCursor: null }), threadPage: async () => ({ data: [
    { id: 'a', cwd: 'C:\\alpha', projectId: 'deleted-project' },
    { id: 'b', cwd: 'C:\\alpha', projectId: null, source: { subAgent: {} } },
    { id: 'c', cwd: 'C:\\alpha', projectId: null, canAcceptDirectInput: false },
  ], nextCursor: null }) };
  assert.equal((await readCatalog(c)).threads.length, 0);
});

test('repeated pagination cursors fail closed instead of hanging the voice request', async () => {
  const c = { projectPage: async () => ({ data: [], nextCursor: 'same' }), threadPage: async () => ({ data: [], nextCursor: null }) };
  await assert.rejects(readCatalog(c), { code: 'CATALOG_INVALID' });
});
