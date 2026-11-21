import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../bridge/recent-conversations.mjs';

const workspace = (id, projectKey = id) => ({ id, title: `项目 ${id}`, project: { projectKey } });
const agent = (id, workspaceId, lastUserMessageAt, extra = {}) => ({
  id, workspaceId, title: `对话 ${id}`, status: 'idle', lastUserMessageAt,
  updatedAt: '2026-10-29T12:00:00Z', archivedAt: null, ...extra,
});
const first = '2026-10-28T02:00:00.000Z';
const second = '2026-10-28T03:00:00.000Z';
const third = '2026-10-29T01:00:00.000Z';
const now = Date.parse('2026-10-29T04:00:00Z');
const options = { scopeKey: 'test-host', now };
const read = async (client, extra = {}) => (await api.readRecentPaseoConversations(client, { ...options, ...extra })).items;
const resolve = (client, snapshot, extra = {}) => api.resolveRecentPaseoConversation(client, {
  snapshot, backend: 'paseo', scopeKey: options.scopeKey, itemIndex: 0, now, ...extra,
});

function fixture({ workspaces = [workspace('w1'), workspace('w2')],
  agents = [agent('a1', 'w1', first), agent('a2', 'w2', second)],
  workspacePages, agentPages } = {}) {
  const calls = [];
  const client = {
    workspaces: { async list(options) {
      calls.push({ type: 'workspaces', options });
      return workspacePages?.[options.page.cursor ?? 'first'] ?? { entries: workspaces, pageInfo: {} };
    } },
    agents: {
      async list(options) {
        assert.ok(options.filter.projectKeys.length, 'recent reads must stay scoped to visible projects');
        calls.push({ type: 'agents', options });
        return agentPages?.[options.page.cursor ?? 'first'] ?? { entries: agents.map(agent => ({ agent })), pageInfo: {} };
      },
      ref(id) { return { async refresh() { return { agent: agents.find(a => a.id === id) }; } }; },
    },
  };
  return { client, calls, workspaces, agents };
}

test('recent conversations sort across projects by user messages, ignoring background updates', async () => {
  assert.equal(typeof api.readRecentPaseoConversations, 'function');
  const f = fixture();
  f.agents[0].updatedAt = '2030-01-01T00:00:00Z';
  const items = await read(f.client);
  assert.deepEqual(items.map(i => [i.workspaceId, i.agentId]), [['w2', 'a2'], ['w1', 'a1']]);
  assert.deepEqual(items[0], { backend: 'paseo', workspaceId: 'w2', agentId: 'a2',
    projectKey: 'w2', workspaceName: '项目 w2', name: '对话 a2', status: 'idle',
    lastUserMessageAt: second, updatedAt: '2026-10-29T12:00:00.000Z' });
});

test('all scoped pages are read before ranking; identical names do not collapse distinct identities', async () => {
  const f = fixture({
    workspacePages: {
      first: { entries: [workspace('w1', 'p')], pageInfo: { nextCursor: 'w-next' } },
      'w-next': { entries: [workspace('w2', 'p')], pageInfo: {} },
    },
    agentPages: {
      first: { entries: [{ agent: agent('a1', 'w1', first, { title: '重名' }) }], pageInfo: { nextCursor: 'a-next' } },
      'a-next': { entries: [{ agent: agent('a2', 'w2', third, { title: '重名' }) },
        { agent: agent('a3', 'other', third) }], pageInfo: {} },
    },
  });
  const items = await read(f.client);
  assert.deepEqual(items.map(i => i.agentId), ['a2', 'a1']);
  assert.ok(f.calls.filter(c => c.type === 'agents').every(c => c.options.filter.projectKeys.join() === 'p'));
});

test('unknown user times never fall back to update time and non-visible entries are excluded', async () => {
  const f = fixture({ workspaces: [workspace('w1'), { ...workspace('archived'), archivedAt: first }], agents: [
    agent('valid', 'w1', second), agent('empty', 'w1', null), agent('bad', 'w1', 'not-a-date'),
    agent('local-date', 'w1', '2026-10-29'), agent('archived-agent', 'w1', third, { archivedAt: third }),
    agent('internal-agent', 'w1', third, { internal: true }), agent('archived-project', 'archived', third),
    agent('exclude-me', 'w1', third),
  ] });
  const snapshot = await api.readRecentPaseoConversations(f.client, { ...options, excludeAgentIds: ['exclude-me'] });
  const items = snapshot.items;
  assert.deepEqual(items.map(i => i.agentId), ['valid']);
  assert.equal(snapshot.coverage, 'partial');
  assert.equal(snapshot.omittedWithoutUserTime, 3);
});

test('an empty directory never causes an unscoped query and a missing project key fails closed', async () => {
  const empty = fixture({ workspaces: [] });
  assert.deepEqual(await read(empty.client), []);
  assert.equal(empty.calls.some(c => c.type === 'agents'), false);
  const missing = fixture({ workspaces: [{ id: 'w1', title: '缺少归属' }] });
  await assert.rejects(read(missing.client), { code: 'MISSING_SCOPE' });
  assert.equal(missing.calls.some(c => c.type === 'agents'), false);
});

test('looping page cursors fail without leaking private server errors', async () => {
  const f = fixture({ workspacePages: {
    first: { entries: [workspace('w1')], pageInfo: { nextCursor: 'again' } },
    again: { entries: [], pageInfo: { nextCursor: 'again' } },
  } });
  await assert.rejects(read(f.client), { code: 'INVALID_PAGE' });
  const broken = fixture();
  broken.client.agents.list = async () => { throw new Error('private-server-address-and-token'); };
  await assert.rejects(read(broken.client), error =>
    error.code === 'RECENT_READ_FAILED' && !/private-server/.test(error.message));
});

test('repeated agent snapshots are deduplicated but conflicting workspace identities are rejected', async () => {
  const f = fixture({ agents: [agent('a1', 'w1', first), agent('a1', 'w1', second)] });
  assert.deepEqual((await read(f.client)).map(i => i.lastUserMessageAt), [second]);
  f.agents.push(agent('a1', 'w2', third));
  await assert.rejects(read(f.client), { code: 'RECENT_IDENTITY_CONFLICT' });
});

test('only display metadata is returned, including for running conversations', async () => {
  const f = fixture({ agents: [agent('a1', 'w1', second, { status: 'running',
    title: '标题\n下一行', preview: 'private-preview', turns: ['private-history'],
    persistence: { value: 'private-persistence' }, pendingPermissions: ['private-permission'] })] });
  const items = await read(f.client);
  assert.equal(items[0].status, 'running');
  assert.equal(items[0].name, '标题 下一行');
  assert.doesNotMatch(JSON.stringify(items), /private-/);
});

test('selection rechecks exact agent and workspace without sending a message or saving state', async () => {
  const f = fixture();
  const snapshot = await api.readRecentPaseoConversations(f.client, options);
  assert.deepEqual(await resolve(f.client, snapshot), snapshot.items[0]);
  f.agents[1].workspaceId = 'w1';
  await assert.rejects(resolve(f.client, snapshot), { code: 'RECENT_STALE' });
});

test('an archived project or agent, an identity mismatch, and the wrong backend cannot be selected', async () => {
  const f = fixture();
  const snapshot = await api.readRecentPaseoConversations(f.client, options);
  f.workspaces[1].archivedAt = third;
  await assert.rejects(resolve(f.client, snapshot), { code: 'RECENT_STALE' });
  delete f.workspaces[1].archivedAt;
  f.agents[1].archivedAt = third;
  await assert.rejects(resolve(f.client, snapshot), { code: 'RECENT_STALE' });
  f.client.agents.ref = () => ({ async refresh() { return { agent: agent('different-id', 'w2', third) }; } });
  await assert.rejects(resolve(f.client, snapshot), { code: 'RECENT_STALE' });
  await assert.rejects(resolve(f.client, snapshot, { backend: 'codex' }), { code: 'RECENT_STALE' });
});

test('snapshot describes scope, time source, coverage and a fixed two-minute lifetime', async () => {
  const snapshot = await api.readRecentPaseoConversations(fixture().client, options);
  assert.equal(snapshot.backend, 'paseo');
  assert.equal(snapshot.scopeKey, 'test-host');
  assert.equal(snapshot.sortBasis, 'lastUserMessageAt');
  assert.equal(snapshot.source, 'paseo.agent.lastUserMessageAt');
  assert.equal(snapshot.coverage, 'complete');
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  assert.equal(Date.parse(snapshot.expiresAt) - now, 120000);
  assert.throws(() => snapshot.items.reverse(), TypeError);
  assert.throws(() => { snapshot.items[0].workspaceId = 'other'; }, TypeError);
});

test('old, foreign-scope and out-of-range snapshot selections fail before reading a target', async () => {
  const f = fixture();
  const snapshot = await api.readRecentPaseoConversations(f.client, options);
  f.client.agents.ref = () => { assert.fail('invalid selection must not read a target'); };
  for (const extra of [{ now: now + 120000 }, { now: now - 1 }, { scopeKey: 'other' },
    { itemIndex: -1 }, { itemIndex: 2 }, { itemIndex: 0.5 }]) {
    await assert.rejects(resolve(f.client, snapshot, extra), { code: 'RECENT_STALE' });
  }
});

test('a project key change invalidates a snapshot even when IDs still exist', async () => {
  const f = fixture();
  const snapshot = await api.readRecentPaseoConversations(f.client, options);
  f.workspaces[1].project.projectKey = 'changed';
  await assert.rejects(resolve(f.client, snapshot), { code: 'RECENT_STALE' });
});

test('malformed date-times are omitted and offset times are sorted as instants', async () => {
  const f = fixture({ agents: [agent('old', 'w1', '2026-10-29T10:00:00+08:00'),
    agent('new', 'w2', '2026-10-29T03:00:00Z'), agent('impossible', 'w1', '2026-02-30T00:00:00Z'),
    agent('no-zone', 'w1', '2026-10-29T05:00:00')] });
  assert.deepEqual((await read(f.client)).map(i => i.agentId), ['new', 'old']);
});

test('equal user times have stable identity order instead of following changing API list order', async () => {
  const f = fixture({ agents: [agent('z', 'w2', first), agent('a', 'w1', first)] });
  const original = await read(f.client);
  f.agents.reverse();
  assert.deepEqual(await read(f.client), original);
});

test('read validation rejects missing scope and malformed page metadata without guessing', async () => {
  const f = fixture();
  await assert.rejects(api.readRecentPaseoConversations(f.client), { code: 'INVALID_INPUT' });
  f.client.workspaces.list = async () => ({ entries: [], pageInfo: { nextCursor: 123 } });
  await assert.rejects(read(f.client), { code: 'INVALID_PAGE' });
});

test('a copied or replaced snapshot cannot inject a conversation that was not in the listing', async () => {
  const f = fixture();
  const snapshot = await api.readRecentPaseoConversations(f.client, options);
  await assert.rejects(resolve(f.client, { ...snapshot }), { code: 'RECENT_STALE' });
});

test('a disappearing target is stale and refresh failures are sanitized', async () => {
  const f = fixture();
  const snapshot = await api.readRecentPaseoConversations(f.client, options);
  f.agents.pop();
  await assert.rejects(resolve(f.client, snapshot), { code: 'RECENT_STALE' });
  f.client.agents.ref = () => ({ async refresh() { throw Object.assign(new Error('private-refresh-token'), { code: 'RECENT_STALE' }); } });
  await assert.rejects(resolve(f.client, snapshot), error =>
    error.code === 'RECENT_READ_FAILED' && !/private-/.test(error.message));
});

test('an unknown user time duplicated before a known one does not hide the known conversation', async () => {
  const f = fixture({ agents: [agent('a', 'w1', null), agent('a', 'w1', first)] });
  assert.deepEqual((await read(f.client)).map(i => i.lastUserMessageAt), [first]);
});

test('a duplicated workspace with conflicting project keys stops before requesting agents', async () => {
  const f = fixture({ workspaces: [workspace('w1', 'old'), workspace('w1', 'new')] });
  await assert.rejects(read(f.client), { code: 'RECENT_IDENTITY_CONFLICT' });
  assert.equal(f.calls.some(c => c.type === 'agents'), false);
});
