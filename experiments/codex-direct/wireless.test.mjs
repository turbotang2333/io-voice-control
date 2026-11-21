import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createDesktopGateway } from './desktop-gateway.mjs';
import { createHandler } from './http.mjs';

test('wireless proposal reuses the shared relay safely without starting or replacing it', async () => {
  assert.ok(existsSync(new URL('./wireless-preflight.mjs', import.meta.url)), 'wireless preparation entry is missing');
  const { wirelessProposal } = await import('./wireless-preflight.mjs');
  const proposal = wirelessProposal('fixture-host');
  assert.equal(proposal.activation, 'not-authorized-or-started');
  assert.equal(proposal.path, '/rayneo-codex/');
  assert.ok(proposal.relayArgs.includes('127.0.0.1:17469:127.0.0.1:17469'));
  assert.ok(proposal.relayArgs.includes('StrictHostKeyChecking=yes'));
  assert.ok(!proposal.relayArgs.join(' ').includes('17467'));
  assert.throws(() => wirelessProposal('-unsafe'));
});

test('proxy candidate preserves ownership headers, verifies TLS and disables request replay', () => {
  assert.ok(existsSync(new URL('./wireless.location.conf', import.meta.url)), 'Codex proxy candidate is missing');
  const config = readFileSync(new URL('./wireless.location.conf', import.meta.url), 'utf8');
  for (const directive of ['location ^~ /rayneo-codex/ {', 'proxy_pass https://127.0.0.1:17469/;',
    'proxy_set_header Authorization $http_authorization;', 'proxy_set_header Idempotency-Key $http_idempotency_key;',
    'proxy_ssl_verify on;', 'proxy_ssl_name localhost;', 'proxy_next_upstream off;', 'proxy_buffering off;', 'access_log off;']) {
    assert.ok(config.includes(directive), directive);
  }
  assert.ok(!/location\s+[^\n]*\/rayneo-paseo\//u.test(config));
});

for (const backendLost of [false, true]) {
  test(`a disconnected phone never causes a second desktop send, backendLost=${backendLost}`, async t => {
    let sends = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = { data: { version: 1, requests: [] }, save() {} };
    const client = { authorizedThreadId: 'wireless-fixture', async call(name) {
      if (name === 'send_message_to_thread') { sends++; return { threadId: 'wireless-fixture' }; }
      if (name !== 'read_thread') throw new Error('unexpected tool');
      if (!sends) return { thread: { id: 'wireless-fixture', status: { type: 'idle' } }, turns: [{ id: 'before' }] };
      await gate;
      if (backendLost) throw Object.assign(new Error(), { code: 'DESKTOP_DISCONNECTED' });
      return { thread: { id: 'wireless-fixture', status: { type: 'idle' } }, turns: [{ id: 'own-turn', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'synthetic probe' }] },
        { type: 'agentMessage', phase: 'final_answer', text: 'synthetic reply' },
      ] }] };
    } };
    const target = { threadId: 'wireless-fixture', hostId: 'local' };
    let gateway = createDesktopGateway(client, { state, target });
    let finished;
    const handled = new Promise(resolve => { finished = resolve; });
    const handler = createHandler({ token: 'a'.repeat(64), gateway: { async submit(input) {
      try { return await gateway.submit(input); } finally { finished(); }
    } } });
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { release(); server.closeAllConnections(); server.close(resolve); }));
    const body = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'synthetic probe' }] });
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions', method: 'POST',
      headers: { authorization: 'Bearer ' + 'a'.repeat(64), 'idempotency-key': 'lost-phone', 'content-type': 'application/json' } });
    req.on('error', () => {});
    const responseReady = once(req, 'response'); req.end(body);
    const [response] = await responseReady;
    const closed = new Promise(resolve => response.once('close', resolve)); response.on('error', () => {});
    req.destroy(); await closed;
    release(); await handled;
    assert.equal(sends, 1);
    assert.equal(state.data.requests[0].status, backendLost ? 'unknown' : 'idle');
    gateway = createDesktopGateway(client, { state, target });
    const replay = await gateway.submit({ requestId: 'lost-phone', text: 'synthetic probe' });
    assert.equal(replay.status, 'unknown'); assert.equal(sends, 1);
    if (backendLost) await assert.rejects(gateway.submit({ requestId: 'new-message', text: 'new synthetic probe' }), { code: 'OUTCOME_UNKNOWN' });
    assert.ok(!JSON.stringify(state.data).includes('synthetic probe'));
  });
}
