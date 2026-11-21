import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { QueueClient } from './client.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
test('real shared transport authenticates, observes approval, clears it and never answers a server approval request', async t => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'shared-')), tokenFile = join(root, 'token');
  const token = 'synthetic-token-'.repeat(4); writeFileSync(tokenFile, token);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let approval = true, socket, unexpectedResponse = false;
  server.on('connection', (s, req) => {
    socket = s;
    if (req.headers.authorization !== 'Bearer ' + token) { s.close(1008); return; }
    s.on('message', bytes => {
      const m = JSON.parse(bytes);
      if (m.id === 'approval-request') { unexpectedResponse = true; return; }
      if (m.method === 'initialized') return;
      const values = { initialize: {}, 'account/read': { account: { type: 'chatgpt' } },
        'thread/read': { thread: { id: threadId, status: { type: 'active', activeFlags: approval ? ['waitingOnApproval'] : [] } } },
        'thread/turns/list': { data: [{ id: 'turn-1', status: 'inProgress', items: [] }] } };
      assert.ok(Object.hasOwn(values, m.method), 'transport must not take over or execute a task');
      s.send(JSON.stringify({ id: m.id, result: values[m.method] }));
    });
  });
  const c = new QueueClient({ threadId, sharedConnection: {
    endpoint: `ws://127.0.0.1:${server.address().port}/rpc`, tokenFile } });
  t.after(async () => {
    await c.close(); for (const s of server.clients) s.terminate(); await new Promise(r => server.close(r));
    assert.ok(resolve(root).startsWith(resolve(parent) + sep)); rmSync(root, { recursive: true, force: true });
  });
  await c.connect();
  assert.equal(await c.approvalActivity('turn-1'), true);
  approval = false; assert.equal(await c.approvalActivity('turn-1'), false);
  assert.ok(c.whenDisconnected instanceof Promise, 'the serving process must notice a lost runtime and release its stale reader');
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ id: 'approval-request', method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId: 'turn-1', itemId: 'tool-1' } }));
  await closed;
  assert.equal(await c.whenDisconnected, 'UNEXPECTED_SERVER_REQUEST');
  assert.equal(c.ready, false); assert.equal(unexpectedResponse, false);
});
