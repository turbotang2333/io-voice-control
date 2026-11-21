import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const api = await import('../bridge/navigation-session.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
test('Codex shortcut capability is opt-in while creation stays disabled', () => {
  const store = { load: () => ({ version: 1, owner: null, highestEpoch: 0 }), save() {} };
  const enabled = api.createNavigationSession({ backend: 'codex', store, invalidate() {}, shortcuts: () => true });
  assert.equal(bind(enabled).shortcuts, true);
  assert.equal(bind(enabled).agentCreation, false);
  const disabled = api.createNavigationSession({ backend: 'codex', store, invalidate() {} });
  assert.equal(bind(disabled).shortcuts, false);
});
function fixture() {
  assert.equal(typeof api.createNavigationSession, 'function');
  let persisted = { version: 1, owner: null, highestEpoch: 0 }, clock = 1000, invalidations = 0;
  const store = { load: () => ({ ...persisted }), save: value => { persisted = { ...value }; } };
  const open = () => api.createNavigationSession({ backend: 'paseo', store,
    now: () => clock, invalidate: () => { invalidations++; } });
  return { store, open, advance: () => { clock += 30001; }, invalidations: () => invalidations,
    persisted: () => persisted };
}
function bind(manager, epoch = 1, installationId = owner) {
  const identity = { installationId, epoch };
  const response = manager.challenge(identity);
  return response.binding ?? manager.bind({ ...identity, challenge: response.challenge }).binding;
}

test('only explicitly enabled servers advertise conversation search in every handshake binding', () => {
  const f = fixture();
  const basic = bind(f.open()); assert.equal(basic.conversationSearch, false);
  const manager = api.createNavigationSession({ backend: 'paseo', store: f.store,
    invalidate() {}, conversationSearch: true });
  assert.equal(bind(manager).conversationSearch, true);
  manager.invalidateConnection(); assert.equal(bind(manager).conversationSearch, true);
});

test('creation support is checked on each binding and never advertised by a Codex entry', () => {
  const f = fixture(); let supported = false;
  const manager = api.createNavigationSession({ backend: 'paseo', store: f.store, invalidate() {}, agentCreation: () => supported });
  assert.equal(bind(manager).agentCreation, false);
  supported = true; assert.equal(bind(manager).agentCreation, true);
  const codex = api.createNavigationSession({ backend: 'codex', store: f.store, invalidate() {}, agentCreation: () => true });
  assert.equal(bind(codex).agentCreation, false);
  const enabled = api.createNavigationSession({ backend: 'codex', store: f.store, invalidate() {}, agentCreation: () => true, codexCreation: true });
  assert.equal(bind(enabled).agentCreation, true);
});

test('an explicit challenge binds one owner and rejects missing or foreign sessions', () => {
  const f = fixture(), m = f.open();
  assert.throws(() => m.authorize({}), { code: 'NAVIGATION_SESSION_REQUIRED' });
  const binding = bind(m);
  const guard = m.authorize({ ...binding, installationId: owner, epoch: 1 });
  assert.doesNotThrow(guard);
  assert.equal(f.invalidations(), 1);
  assert.throws(() => bind(m, 2, other), { code: 'NAVIGATION_OWNER_MISMATCH' });
  assert.deepEqual(f.persisted(), { version: 1, owner, highestEpoch: 1 });
});

test('new epochs invalidate old guards; older epochs and late competing CAS binds cannot take over', () => {
  const f = fixture(), m = f.open(), first = bind(m);
  const guard = m.authorize({ ...first, installationId: owner, epoch: 1 });
  const late = m.challenge({ installationId: owner, epoch: 2 });
  bind(m, 3);
  assert.throws(guard, { code: 'NAVIGATION_SESSION_STALE' });
  assert.throws(() => m.bind({ installationId: owner, epoch: 2, challenge: late.challenge }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.throws(() => bind(m, 1), { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(f.persisted().highestEpoch, 3);
});

test('lost handshake replies are idempotent without clearing a newly displayed list again', () => {
  const f = fixture(), m = f.open(), identity = { installationId: owner, epoch: 1 };
  const { challenge } = m.challenge(identity);
  const first = m.bind({ ...identity, challenge });
  assert.deepEqual(m.bind({ ...identity, challenge }), first);
  assert.deepEqual(m.challenge(identity).binding, first.binding);
  assert.equal(f.invalidations(), 1);
});

test('connection generations require a fresh handshake even with the same phone epoch', () => {
  const f = fixture(), m = f.open(), old = bind(m);
  const guard = m.authorize({ ...old, installationId: owner, epoch: 1 });
  const pending = m.challenge({ installationId: owner, epoch: 2 });
  m.invalidateConnection();
  assert.throws(guard, { code: 'NAVIGATION_SESSION_STALE' });
  assert.throws(() => m.bind({ installationId: owner, epoch: 2, challenge: pending.challenge }), { code: 'NAVIGATION_SESSION_STALE' });
  const fresh = bind(m);
  assert.notEqual(fresh.generation, old.generation);
  assert.doesNotThrow(m.authorize({ ...fresh, installationId: owner, epoch: 1 }));
});

test('service restart preserves owner and highest epoch, while rejecting all old bindings', () => {
  const f = fixture(), first = f.open(), old = bind(first, 7), restarted = f.open();
  assert.throws(() => restarted.authorize({ ...old, installationId: owner, epoch: 7 }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.throws(() => bind(restarted, 6), { code: 'NAVIGATION_SESSION_STALE' });
  assert.throws(() => bind(restarted, 8, other), { code: 'NAVIGATION_OWNER_MISMATCH' });
  assert.notEqual(bind(restarted, 7).generation, old.generation);
});

test('expired challenges, unsafe epochs and failed persistence never activate a session', () => {
  const f = fixture(), m = f.open();
  const { challenge } = m.challenge({ installationId: owner, epoch: 1 });
  f.advance();
  assert.throws(() => m.bind({ installationId: owner, epoch: 1, challenge }), { code: 'NAVIGATION_SESSION_STALE' });
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => m.challenge({ installationId: owner, epoch }), { code: 'INVALID_INPUT' });
  }
  f.store.save = () => { throw new Error('private-store-path'); };
  assert.throws(() => bind(m), error => error.code === 'STATE_WRITE_FAILED' && !/private-/.test(error.message));
  assert.equal(f.persisted().owner, null);
  assert.equal(f.invalidations(), 0);
});

test('navigation ownership is atomically persisted without selections, prompts or task records', t => {
  assert.equal(typeof api.openNavigationSessionStore, 'function');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-nav-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'owner.json');
  const m = api.createNavigationSession({ backend: 'codex', store: api.openNavigationSessionStore(path), invalidate() {} });
  bind(m, 9);
  const state = api.openNavigationSessionStore(path).load();
  assert.deepEqual(state, { version: 1, owner, highestEpoch: 9 });
});
