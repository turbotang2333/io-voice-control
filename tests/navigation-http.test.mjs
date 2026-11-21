import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequestHandler } from '../bridge/http.mjs';
import { createHandler } from '../experiments/codex-direct/http.mjs';
import { createNavigationSession } from '../bridge/navigation-session.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
for (const [backend, handler] of [['paseo', createRequestHandler], ['codex', createHandler]]) {
  test(`${backend} authenticates handshake and fails closed for missing, stale or restarted sessions`, async t => {
    let state = { version: 1, owner: null, highestEpoch: 0 }, sends = 0;
    const sessions = createNavigationSession({ backend,
      store: { load: () => state, save: next => { state = next; } }, invalidate() {} });
    const server = createServer(handler({ token, sessions, gateway: { async submit({ assertCurrent }) {
      assertCurrent(); sends++;
      return { requestId: 'task', status: 'idle', text: 'ok' };
    } } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, headers = {}, authenticated = true) => fetch(base + path, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body) });
    const handshake = async epoch => {
      const identity = { installationId: owner, epoch };
      const first = await post('/v1/navigation/session', { action: 'challenge', ...identity });
      assert.equal(first.status, 200);
      const result = await first.json();
      if (result.binding) return result.binding;
      const confirm = await post('/v1/navigation/session', { action: 'bind', ...identity, challenge: result.challenge });
      assert.equal(confirm.status, 200);
      return (await confirm.json()).binding;
    };
    const headers = (binding, epoch) => ({ 'idempotency-key': `task-${epoch}`,
      'x-navigation-owner': owner, 'x-navigation-epoch': String(epoch),
      'x-navigation-generation': binding.generation, 'x-navigation-session': binding.sessionToken });
    const input = { messages: [{ role: 'user', content: '测试问题' }] };
    const denied = await post('/v1/navigation/session', { action: 'challenge', installationId: owner, epoch: 1 }, {}, false);
    assert.equal(denied.status, 401); await denied.text();
    assert.equal(state.owner, null);
    const missing = await post('/v1/chat/completions', input);
    assert.equal(missing.status, 409); await missing.text();
    assert.equal(sends, 0);
    const first = await handshake(1);
    const sent = await post('/v1/chat/completions', input, headers(first, 1));
    assert.equal(sent.status, 200); await sent.text();
    const second = await handshake(2);
    const stale = await post('/v1/chat/completions', input, headers(first, 1));
    assert.equal(stale.status, 409); await stale.text();
    sessions.invalidateConnection();
    const oldGeneration = await post('/v1/chat/completions', input, headers(second, 2));
    assert.equal(oldGeneration.status, 409); await oldGeneration.text();
    assert.equal(sends, 1);
    const fresh = await handshake(2);
    assert.notEqual(fresh.generation, second.generation);
  });
}
