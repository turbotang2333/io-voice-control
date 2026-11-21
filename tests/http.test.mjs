import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
const load = () => import('../bridge/http.mjs');

async function fixture(t) {
  const { createRequestHandler } = await load();
  let sends = 0;
  const server = createServer(createRequestHandler({
    token: 'test-only-token', gateway: { async submit(input) {
      sends++;
      assert.deepEqual(input, { requestId: 'r1', text: '测试问题' });
      return { requestId: 'r1', agentId: 'a1', status: 'idle', text: '测试回复' };
    } },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, sends: () => sends };
}

test('authenticated single-user requests reach only the configured gateway', async t => {
  const f = await fixture(t);
  const response = await fetch(f.url, { method: 'POST', headers: { authorization: 'Bearer test-only-token', 'content-type': 'application/json', 'idempotency-key': 'r1' }, body: JSON.stringify({ messages: [{ role: 'user', content: '测试问题' }], stream: false }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, '测试回复');
  assert.equal(f.sends(), 1);
});

test('unauthorized requests and unsupported payloads never submit a turn', async t => {
  const f = await fixture(t);
  for (const [headers, body, status] of [
    [{}, { messages: [{ role: 'user', content: '测试问题' }] }, 401],
    [{ authorization: 'Bearer test-only-token', 'idempotency-key': 'r1' }, { messages: [{ role: 'system', content: 'x' }] }, 400],
    [{ authorization: 'Bearer test-only-token', 'idempotency-key': 'r1' }, { messages: [{ role: 'user', content: '测试问题' }], stream: 'invalid' }, 400],
  ]) {
    const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal(response.status, status);
    await response.text();
  }
  assert.equal(f.sends(), 0);
});

test('authenticated health reports an outage and disconnected requests are never queued or submitted', async t => {
  const { createRequestHandler } = await load();
  let online = false, sends = 0;
  const server = createServer(createRequestHandler({ token: 'test-only-token', isReady: () => online, gateway: {
    async submit() { sends++; return { status: 'idle', text: '恢复后新请求' }; },
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const denied = await fetch(`${base}/healthz`);
  assert.equal(denied.status, 401); await denied.text();
  const health = await fetch(`${base}/healthz`, { headers: { authorization: 'Bearer test-only-token' } });
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, status: 'reconnecting' });
  const send = () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: {
    authorization: 'Bearer test-only-token', 'idempotency-key': 'offline-one',
  }, body: JSON.stringify({ messages: [{ role: 'user', content: '离线时的新请求' }] }) });
  const offline = await send();
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).error.code, 'PASEO_OFFLINE');
  online = true;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 0, 'reconnection must never replay an offline request');
  const ready = await fetch(`${base}/healthz`, { headers: { authorization: 'Bearer test-only-token' } });
  assert.deepEqual(await ready.json(), { ok: true, status: 'ready' });
  const fresh = await send();
  assert.equal(fresh.status, 200); await fresh.text();
  assert.equal(sends, 1);
});

test('streaming delivers an early reply and waiting signal before the final answer', async t => {
  const { createRequestHandler } = await load();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const server = createServer(createRequestHandler({ token: 'test-only-token', gateway: {
    async submit({ onUpdate }) {
      onUpdate({ type: 'state', state: 'working' });
      onUpdate({ type: 'text', text: '先处理' });
      onUpdate({ type: 'state', state: 'tool' });
      await done;
      return { requestId: 'r1', agentId: 'a1', status: 'idle', text: '先处理\n已完成' };
    },
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer test-only-token', 'idempotency-key': 'r1' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '测试问题' }], stream: true }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  const initial = new TextDecoder().decode(first.value);
  assert.match(initial, /"type":"text","text":"先处理"/);
  finish();
  let remaining = '';
  for (;;) { const part = await reader.read(); if (part.done) break; remaining += new TextDecoder().decode(part.value); }
  assert.match(remaining, /"type":"done"/);
  assert.match(remaining, /已完成/);
});
