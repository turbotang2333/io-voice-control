import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnGateway } from '../bridge/turns.mjs';

// The native boundary is controlled; the real gateway owns correlation, waiting and deduplication.
function fixture({ outcome = 'idle', foreign = false, neverResolves = false, unbound = false } = {}) {
  let listener, time = 0, sends = 0, waits = 0, releases = 0;
  const snapshot = (pending, turnId = 'own-turn') => ({ id: 'a1', workspaceId: 'w1', status: pending ? 'running' : outcome,
    archivedAt: null, activeTurn: pending ? { turnId, startedAt: '2026-11-09T00:00:00Z' } : null,
    pendingPermissions: pending ? [{ id: 'permission-1' }] : [] });
  const event = (item, turnId = 'own-turn') => listener?.({ agentId: 'a1', event: { type: 'timeline', turnId, item } });
  const handle = {
    async refresh() { return { agent: snapshot(false) }; },
    timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() { releases++; } }; } },
    async run(_text, options) {
      sends++;
      if (!unbound) event({ type: 'user_message', messageId: options.messageId, text: 'test task' });
      return { status: 'permission', final: snapshot(true), lastMessage: null };
    },
    async waitForFinish(remaining) {
      waits++; assert.ok(remaining > 0 && remaining <= 30);
      if (foreign) event({ type: 'user_message', messageId: 'another-request', text: 'private other task' }, 'other-turn');
      return neverResolves ? { status: 'permission', final: snapshot(true), lastMessage: null }
        : { status: outcome, final: snapshot(false), lastMessage: foreign ? 'private other reply' : 'test final reply' };
    },
    respondToPermission() { assert.fail('must never grant or decline permissions'); },
  };
  const gateway = createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1',
    timeoutMs: 30, pollMs: 10, now: () => time, sleep: async ms => { time += ms; } });
  return { gateway, counts: () => ({ sends, waits, releases, time }) };
}

for (const outcome of ['idle', 'error']) test(`Paseo keeps its own permission-blocked turn until ${outcome}, with one send`, async () => {
  const f = fixture({ outcome }), frames = [], input = { requestId: 'one', text: 'test task', onUpdate: f => frames.push(f) };
  const result = await f.gateway.submit(input);
  assert.equal(result.status, outcome);
  assert.equal(result.text, outcome === 'idle' ? 'test final reply' : null);
  assert.deepEqual(frames.filter(f => f.state === 'permission'), [{ type: 'state', state: 'permission' }]);
  assert.deepEqual(await f.gateway.submit(input), result);
  assert.equal(f.counts().sends, 1); assert.equal(f.counts().waits, 1); assert.equal(f.counts().releases, 1);
});

test('repeated permission results share one deadline and one progress label without replay', async () => {
  const f = fixture({ neverResolves: true }), frames = [];
  const input = { requestId: 'one', text: 'test task', onUpdate: x => frames.push(x) };
  const result = await f.gateway.submit(input);
  assert.equal(result.status, 'timeout'); assert.equal(result.text, null);
  assert.equal(f.counts().time, 30); assert.equal(f.counts().sends, 1);
  assert.equal(frames.filter(f => f.state === 'permission').length, 1);
  await f.gateway.submit(input); assert.equal(f.counts().sends, 1);
});

test('a new foreign turn during authorization never becomes the glasses reply', async () => {
  const f = fixture({ foreign: true });
  const result = await f.gateway.submit({ requestId: 'one', text: 'test task', onUpdate() {} });
  assert.equal(result.status, 'unknown'); assert.equal(result.text, null);
  assert.equal(f.counts().sends, 1); assert.equal(f.counts().releases, 1);
});

test('unbound authorization cannot start following a different task', async () => {
  const f = fixture({ unbound: true });
  const result = await f.gateway.submit({ requestId: 'one', text: 'test task', onUpdate() {} });
  assert.equal(result.status, 'unknown'); assert.equal(result.text, null);
  assert.equal(f.counts().waits, 0);
});
