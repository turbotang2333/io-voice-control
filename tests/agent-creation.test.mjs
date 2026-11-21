import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgentCreation } from '../bridge/agent-creation.mjs';
import { openCreationStore } from '../bridge/creation-store.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(homedir(), '.local/state/rayneo-paseo/test-create-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'creations.json'), calls = [], agents = [];
  const workspaces = [{ id: 'w1', title: '测试项目', workspaceDirectory: 'C:\\example', project: { projectKey: 'p1' } }];
  const profiles = [{ name: '日常工作', provider: 'codex', model: 'test-model', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: false } }];
  const client = {
    supportsAgentCreation: () => true,
    config: { get: async () => ({ config: { agentProfiles: profiles } }) },
    workspaces: {
      list: async () => ({ entries: workspaces, pageInfo: {} }),
      ref(id) { let current; return {
        refresh: async () => (current = workspaces.find(w => w.id === id)),
        agents: { create: async value => {
          calls.push(value);
          const agent = { id: value.agentId, workspaceId: current.id, title: value.title, status: 'idle' };
          agents.push(agent); return { id: agent.id, current: () => agent };
        } },
      }; },
    },
    agents: {
      list: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: {} }),
      ref: id => ({ refresh: async () => ({ agent: agents.find(a => a.id === id) }) }),
    },
  };
  const store = openCreationStore(path);
  const service = createAgentCreation(client, { store, ...options });
  return { client, store, service, calls, agents, workspaces, profiles, path };
}
const input = (requestId = 'r1') => ({ requestId, title: '推送调试', workspaceId: 'w1' });

test('a fresh user can use their single existing profile without renaming it to the developers profile', async t => {
  const f = fixture(t); f.profiles[0].name = 'My default profile';
  await f.service.create(input());
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].config.provider, 'codex/test-model');
});

test('creation uses the current named profile, existing workspace, fixed ID and no prompt or parent', async t => {
  const f = fixture(t), states = [];
  f.profiles[0].model = 'updated-model';
  const result = await f.service.create({ ...input(), onUpdate: state => states.push(state) });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].config, { provider: 'codex/updated-model', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: false } });
  assert.equal(f.calls[0].title, '推送调试');
  assert.match(f.calls[0].agentId, /^[a-f0-9-]{36}$/);
  assert.ok(f.calls[0].idempotencyKey);
  for (const key of ['prompt', 'parent', 'env', 'background', 'worktree', 'git', 'initialPrompt']) assert.equal(Object.hasOwn(f.calls[0], key), false);
  assert.equal(result.agentId, f.calls[0].agentId);
  assert.equal(result.workspaceId, 'w1');
  assert.equal(f.store.get('r1').status, 'created');
  assert.deepEqual(states, [{ type: 'state', state: 'creating' }]);
});

test('missing scope, empty or oversized names, unsupported host and missing or ambiguous profile never create', async t => {
  const f = fixture(t);
  for (const value of [{ title: '' }, { title: '字'.repeat(41) }, { title: '一\n二' }, { workspaceId: 'gone' }]) {
    await assert.rejects(f.service.create({ ...input(), ...value }));
  }
  f.profiles.length = 0;
  await assert.rejects(f.service.create(input()), { code: 'CREATION_PROFILE' });
  f.profiles.push({ name: '日常工作', provider: 'codex' }, { name: '日常工作', provider: 'codex' });
  await assert.rejects(f.service.create(input()), { code: 'CREATION_PROFILE' });
  f.client.supportsAgentCreation = () => false;
  await assert.rejects(f.service.create(input()), { code: 'CREATION_UNSUPPORTED' });
  assert.equal(f.calls.length, 0);
});

test('same name, replay and a failed durable reservation never produce another Agent', async t => {
  const f = fixture(t);
  await f.service.create(input());
  await assert.rejects(f.service.create(input()), { code: 'CREATION_REPLAY' });
  await assert.rejects(f.service.create(input('r2')), { code: 'CREATION_DUPLICATE' });
  const other = createAgentCreation(f.client, { store: { get: () => null, pending: () => [], reserve() { throw new Error('disk'); } } });
  await assert.rejects(other.create({ ...input('r3'), title: '另一个标题' }), { code: 'CREATION_STORE_WRITE_FAILED' });
  assert.equal(f.calls.length, 1);
});

test('a request losing ownership before dispatch cannot create, and one losing it afterward cannot select', async t => {
  const f = fixture(t); let valid = true;
  const assertCurrent = () => { if (!valid) throw Object.assign(new Error('stale'), { code: 'NAVIGATION_SESSION_STALE' }); };
  const originalGet = f.client.config.get;
  f.client.config.get = async () => { const result = await originalGet(); valid = false; return result; };
  await assert.rejects(f.service.create({ ...input(), assertCurrent }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(f.calls.length, 0);
  valid = true; f.client.config.get = originalGet;
  const originalRef = f.client.workspaces.ref;
  f.client.workspaces.ref = id => { const ref = originalRef(id), create = ref.agents.create; ref.agents.create = async options => { const result = await create(options); valid = false; return result; }; return ref; };
  await assert.rejects(f.service.create({ ...input('r2'), assertCurrent }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('r2').status, 'created');
});

test('timeout survives restart, blocks a same-name retry and late completion only updates the receipt', async t => {
  const f = fixture(t, { timeoutMs: 15 }); let release, last;
  f.client.workspaces.ref = () => ({ refresh: async () => f.workspaces[0], agents: { create: options => {
    f.calls.push(options); last = options;
    return new Promise(resolve => { release = () => { const agent = { id: options.agentId, workspaceId: 'w1', title: options.title }; f.agents.push(agent); resolve({ id: agent.id, current: () => agent }); }; });
  } } });
  await assert.rejects(f.service.create(input()), { code: 'CREATION_UNCERTAIN' });
  const restored = createAgentCreation(f.client, { store: openCreationStore(f.path), timeoutMs: 15 });
  await assert.rejects(restored.create(input('retry')), { code: 'CREATION_UNCERTAIN' });
  assert.equal(f.calls.length, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.get('r1').status, 'created');
  assert.equal(f.store.get('r1').agentId, last.agentId);
});

test('wrong returned target or a changed workspace is never accepted as a successful creation', async t => {
  const f = fixture(t);
  f.client.workspaces.ref = () => ({ refresh: async () => f.workspaces[0], agents: { create: async options => {
    f.calls.push(options); return { id: options.agentId, current: () => ({ id: options.agentId, workspaceId: 'wrong' }) };
  } } });
  await assert.rejects(f.service.create(input()), { code: 'CREATION_UNCERTAIN' });
  assert.equal(f.store.get('r1').status, 'pending');
});
