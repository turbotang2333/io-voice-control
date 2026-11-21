import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readCatalog } from './catalog.mjs';
const api = await import('./creation.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const stores = await import('./creation-store.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });

function fixture(t) {
  assert.equal(typeof api.createConnectorCreation, 'function');
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'creation-')), path = join(root, 'creation.json');
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(parent) + '\\')); rmSync(root, { recursive: true, force: true }); });
  const snapshots = new Map(), listed = [], projects = [{ id: 'p', name: '项目', roots: [{ path: 'C:\\project' }] }];
  let creates = 0, closes = 0, lastScope, failAfterCreate = false, wakeCalls = 0, onConnect = () => {};
  const source = { executable: 'native', codexHome: 'C:\\fake-codex', ready: true, knownThreads: new Set(),
    isDesktopAvailable: () => true,
    projectPage: async () => ({ data: structuredClone(projects) }),
    threadPage: async () => ({ data: structuredClone(listed) }),
    storedCreationSnapshot: async id => structuredClone(snapshots.get(id)),
  };
  const factory = options => ({ async connect() { lastScope = options.creationScope; onConnect(); }, async createEmpty(name, onCreated) {
    const id = 'created-' + ++creates; await onCreated(id);
    if (failAfterCreate) throw Error('lost create acknowledgement');
    const snapshot = { id, name, cwd: 'C:\\project', projectId: 'p', ephemeral: false, canAcceptDirectInput: true,
      path: 'C:\\fake-codex\\sessions\\test.jsonl' };
    snapshots.set(id, snapshot); return structuredClone(snapshot);
  }, async close() { closes++; } });
  let store = stores.openCreationStore(path);
  const make = () => api.createConnectorCreation(source, { store, creatorFactory: factory,
    wake: { available: () => true, run: async () => { wakeCalls++; } } });
  let creation = make();
  t.after(() => creation.close());
  return { source, path, snapshots, listed, projects, get creation() { return creation; }, creates: () => creates, closes: () => closes,
    scope: () => lastScope, wakeCalls: () => wakeCalls, fail() { failAfterCreate = true; }, onConnect(fn) { onConnect = fn; },
    async restart() { await creation.close(); store = stores.openCreationStore(path); creation = make(); } };
}

test('creation uses only the selected native project, persists no title, and restores an empty thread to the catalog', async t => {
  const f = fixture(t);
  const target = await f.creation.create({ requestId: 'create-1', title: '新功能讨论', projectId: 'p' });
  assert.equal(target.threadId, 'created-1'); assert.equal(target.projectId, 'p');
  assert.deepEqual(f.scope(), { projectId: 'p', cwd: 'c:\\project' }); assert.equal(f.closes(), 1);
  assert.doesNotMatch(readFileSync(f.path, 'utf8'), /新功能讨论|C:\\\\project/);
  assert.equal((await readCatalog(f.source)).threads[0].id, 'created-1');
  await f.restart(); assert.equal((await readCatalog(f.source)).threads[0].id, 'created-1');
  await assert.rejects(f.creation.create({ requestId: 'create-1', title: '新功能讨论', projectId: 'p' }), { code: 'CREATION_REPLAY' });
  await assert.rejects(f.creation.create({ requestId: 'create-2', title: '新功能讨论', projectId: 'p' }), { code: 'CREATION_DUPLICATE' });
  assert.equal(f.creates(), 1); assert.equal(f.wakeCalls(), 0);
});

test('an uncertain creation is never repeated after restart, even under a new request ID', async t => {
  const f = fixture(t); f.fail();
  await assert.rejects(f.creation.create({ requestId: 'create-1', title: '测试', projectId: 'p' }), { code: 'CREATION_UNCERTAIN' });
  assert.equal(f.closes(), 1); await f.restart();
  await assert.rejects(f.creation.create({ requestId: 'create-2', title: '换一个名称', projectId: 'p' }), { code: 'CREATION_UNCERTAIN' });
  assert.equal(f.creates(), 1);
});

test('invalid names, absent projects, and ambiguous roots do not start a creator', async t => {
  const f = fixture(t);
  for (const title of ['', '长'.repeat(41), '隐\u200b藏']) await assert.rejects(f.creation.create({ requestId: 'bad', title, projectId: 'p' }), { code: 'CREATION_NAME' });
  await assert.rejects(f.creation.create({ requestId: 'other', title: '测试', projectId: 'other' }), { code: 'CREATION_SCOPE' });
  f.projects[0].roots.push({ path: 'C:\\second' });
  await assert.rejects(f.creation.create({ requestId: 'multiple', title: '测试', projectId: 'p' }), { code: 'CREATION_SCOPE' });
  assert.equal(f.creates(), 0);
});

test('only connector-created targets can be woken; native listings replace the empty-thread overlay', async t => {
  const f = fixture(t); await f.creation.create({ requestId: 'create-1', title: '测试', projectId: 'p' });
  await f.creation.wakeQueued('other'); assert.equal(f.wakeCalls(), 0);
  await f.creation.wakeQueued('created-1'); assert.equal(f.wakeCalls(), 1);
  f.listed.push(f.snapshots.get('created-1'));
  assert.equal((await readCatalog(f.source)).threads.length, 1);
  // Once native Codex lists the thread, this registry no longer supplies a fallback copy.
  f.listed.splice(0); assert.equal((await readCatalog(f.source)).threads.length, 0);
});

test('an archived empty thread or an unknown storage location is not resurrected in the selectable catalog', async t => {
  const f = fixture(t); await f.creation.create({ requestId: 'create-1', title: '测试', projectId: 'p' });
  const snapshot = f.snapshots.get('created-1');
  for (const path of ['C:\\fake-codex\\archived_sessions\\test.jsonl', undefined, 'C:\\fake-codex\\sessions\\..\\archived_sessions\\test.jsonl']) {
    snapshot.path = path; assert.equal((await readCatalog(f.source)).threads.length, 0);
  }
});

test('a project directory changed during creator connection is rejected before creating or reserving anything', async t => {
  const f = fixture(t); f.onConnect(() => { f.projects[0].roots = [{ path: 'C:\\changed' }]; });
  await assert.rejects(f.creation.create({ requestId: 'create-1', title: '测试', projectId: 'p' }), { code: 'CREATION_SCOPE' });
  assert.equal(f.creates(), 0); assert.equal(f.closes(), 1);
});

test('a connection failure leaves no uncertain reservation and a later new request can succeed', async t => {
  const f = fixture(t); f.onConnect(() => { throw Object.assign(Error(), { code: 'CODEX_DISCONNECTED' }); });
  await assert.rejects(f.creation.create({ requestId: 'create-1', title: '测试', projectId: 'p' }), { code: 'CODEX_DISCONNECTED' });
  f.onConnect(() => {});
  assert.equal((await f.creation.create({ requestId: 'create-2', title: '测试', projectId: 'p' })).threadId, 'created-1');
});

test('a same-name thread appearing during creator connection prevents duplicate creation', async t => {
  const f = fixture(t); f.onConnect(() => { f.listed.push({ id: 'external', name: '测试', cwd: 'C:\\project', projectId: 'p' }); });
  await assert.rejects(f.creation.create({ requestId: 'create-1', title: '测试', projectId: 'p' }), { code: 'CREATION_DUPLICATE' });
  assert.equal(f.creates(), 0);
});
