import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const api = await import('./stdio-proxy.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const token = 'synthetic-test-token-'.repeat(3);

async function fixture(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', bytes => { text += bytes.toString('utf8'); });
  t.after(async () => {
    input.destroy(); output.destroy();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, input, output, text: () => text,
    endpoint: `ws://127.0.0.1:${server.address().port}/rpc` };
}

test('the prototype forwards UTF-8 JSONL and unsolicited events without changing IDs or bodies', async t => {
  assert.equal(typeof api.runStdioProxy, 'function');
  const f = await fixture(t);
  const connected = once(f.server, 'connection');
  const run = api.runStdioProxy({ ...f, token });
  const [socket, request] = await connected;
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  const message = once(socket, 'message');
  const body = JSON.stringify({ id: 7, method: 'synthetic', params: { text: '眼镜测试' } });
  const bytes = Buffer.from(body + '\n');
  const split = bytes.indexOf(Buffer.from('眼')) + 1;
  f.input.write(bytes.subarray(0, split)); f.input.write(bytes.subarray(split));
  assert.equal((await message)[0].toString(), body);
  const returned = once(f.output, 'data');
  socket.send(JSON.stringify({ method: 'event', params: { text: '完成' } }));
  await returned;
  assert.equal(f.text(), '{"method":"event","params":{"text":"完成"}}\n');
  f.input.end(); await run;
});

test('two stdio frames in one chunk remain two messages and an unterminated final frame is forwarded once', async t => {
  assert.equal(typeof api.runStdioProxy, 'function');
  const f = await fixture(t), received = [];
  f.server.on('connection', socket => socket.on('message', data => received.push(data.toString())));
  const connected = once(f.server, 'connection');
  const run = api.runStdioProxy({ ...f, token }); await connected;
  f.input.end('{"id":1}\n{"id":2}'); await run;
  assert.deepEqual(received, ['{"id":1}', '{"id":2}']);
});

test('a broken backend rejects the proxy and never reconnects or repeats a submitted message', async t => {
  assert.equal(typeof api.runStdioProxy, 'function');
  const f = await fixture(t); let connections = 0, messages = 0;
  f.server.on('connection', socket => {
    connections++;
    socket.on('message', () => { messages++; socket.terminate(); });
  });
  const connected = once(f.server, 'connection');
  const run = api.runStdioProxy({ ...f, token });
  const rejected = assert.rejects(run, { code: 'SHARED_TRANSPORT_CLOSED' });
  await connected; f.input.write('{"id":8,"method":"turn/start"}\n');
  await rejected;
  assert.equal(connections, 1); assert.equal(messages, 1);
});

test('public endpoints, URL credentials and missing bearer tokens are rejected before connecting', async () => {
  assert.equal(typeof api.runStdioProxy, 'function');
  for (const options of [
    { endpoint: 'ws://example.com/rpc', token },
    { endpoint: 'ws://127.0.0.1:1/rpc?token=synthetic', token },
    { endpoint: 'ws://user:secret@127.0.0.1:1/rpc', token },
    { endpoint: 'ws://127.0.0.1:1/rpc' },
  ]) {
    await assert.rejects(api.runStdioProxy({ input: new PassThrough(), output: new PassThrough(), ...options }),
      { code: 'INVALID_SHARED_CONNECTION' });
  }
});

test('an oversized input frame is rejected without forwarding a partial task', async t => {
  assert.equal(typeof api.runStdioProxy, 'function');
  const f = await fixture(t); let messages = 0;
  f.server.on('connection', socket => socket.on('message', () => messages++));
  const connected = once(f.server, 'connection');
  const run = api.runStdioProxy({ ...f, token, maxFrameBytes: 32 });
  const rejected = assert.rejects(run, { code: 'SHARED_FRAME_TOO_LARGE' });
  await connected; f.input.write('x'.repeat(33)); await rejected;
  assert.equal(messages, 0);
});

test('owner EOF is a requested shutdown even when the backend drops the close acknowledgement', async t => {
  assert.equal(typeof api.runStdioProxy, 'function');
  const f = await fixture(t);
  f.server.on('connection', socket => {
    // Match the observed Codex transport: stop without echoing a close frame.
    socket._receiver.removeAllListeners('conclude');
    socket._receiver.on('conclude', () => socket.terminate());
  });
  const connected = once(f.server, 'connection');
  const run = api.runStdioProxy({ ...f, token }); await connected;
  f.input.end(); await run;
});
