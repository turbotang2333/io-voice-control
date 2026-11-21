import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopClient, readDesktopResult } from './desktop-client.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('desktop tool errors and malformed results cannot become assistant replies', () => {
  assert.deepEqual(readDesktopResult({ content: [{ type: 'text', text: '{"threads":[]}' }] }), { threads: [] });
  assert.throws(() => readDesktopResult({ isError: true, content: [{ type: 'text', text: 'private diagnostic' }] }), { code: 'DESKTOP_TOOL_REJECTED' });
  assert.throws(() => readDesktopResult({ content: [{ type: 'text', text: 'invalid' }] }), { code: 'DESKTOP_RESULT_INVALID' });
});

test('desktop client cannot send to an unapproved conversation or change app settings', async () => {
  const client = new DesktopClient({ callerThreadId: 'caller', authorizedThreadId: 'test-target' });
  await assert.rejects(client.call('send_message_to_thread', { threadId: 'daily-target', prompt: 'hello' }), { code: 'DESKTOP_TARGET_NOT_AUTHORIZED' });
  await assert.rejects(client.call('update_sidebar_preferences', { sorting: { chats: 'manual' } }), { code: 'DESKTOP_TOOL_NOT_ALLOWED' });
  await client.close();
});

test('listing registered desktop projects is read only and needs no selected conversation', async () => {
  const client = new DesktopClient({ callerThreadId: 'caller' });
  client.ready = true; client.closed = false;
  client.tools = new Set(['list_projects']);
  client.request = async () => ({ content: [{ type: 'text', text: '{"projects":[]}' }] });
  assert.deepEqual(await client.call('list_projects', {}), { projects: [] });
  await client.close();
});

test('test conversation creation requires an explicitly authorized project', async () => {
  const client = new DesktopClient({ callerThreadId: 'caller', creationProjectId: 'authorized-project' });
  client.ready = true; client.closed = false;
  client.tools = new Set(['create_thread']);
  client.request = async () => ({ content: [{ type: 'text', text: '{"threadId":"new-test"}' }] });
  await assert.rejects(client.call('create_thread', { target: { type: 'project', projectId: 'other-project', environment: { type: 'local' } }, prompt: '测试' }), { code: 'DESKTOP_TARGET_NOT_AUTHORIZED' });
  assert.equal((await client.call('create_thread', { target: { type: 'project', projectId: 'authorized-project', environment: { type: 'local' } }, prompt: '测试' })).threadId, 'new-test');
  await client.close();
});

function fakeDesktop({ holdHandshake = false, holdExit = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.stdin.on('finish', () => { if (!holdExit) child.kill(); });
  child.stdin.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      if (request.method === 'initialize' && !holdHandshake) child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
      if (request.method === 'tools/list') child.stdout.write(JSON.stringify({ id: request.id, result: { tools: [{ name: 'list_threads' }] } }) + '\n');
    }
  });
  const client = new DesktopClient({ callerThreadId: 'caller', serverPath: process.execPath, pipePath: 'synthetic-pipe', spawnProcess: () => child });
  return { child, client };
}

test('desktop readiness waits for handshake and malformed input invalidates pending requests exactly once', async () => {
  const { child, client } = fakeDesktop();
  assert.equal(typeof client.subscribeConnectionStatus, 'function');
  const statuses = [];
  client.subscribeConnectionStatus(() => { throw new Error('listener failure'); });
  const off = client.subscribeConnectionStatus(state => statuses.push(state.status));
  await client.connect();
  assert.equal(client.ready, true);
  await assert.rejects(client.connect(), { code: 'DESKTOP_ALREADY_CONNECTED' });
  assert.equal(client.ready, true, 'a rejected duplicate connect must not invalidate a live connection');
  const pending = client.request('pending-synthetic', {});
  child.stdout.write('not-json\n');
  await assert.rejects(pending, { code: 'DESKTOP_DISCONNECTED' });
  child.emit('exit', 1); client.disconnect();
  assert.deepEqual(statuses, ['connecting', 'connected', 'disconnected']);
  assert.equal(client.ready, false); assert.equal(client.pending.size, 0);
  off(); off(); await client.close();
  assert.equal(statuses.length, 3);
});

test('desktop cannot call tools during initialization or while close is waiting for child exit', async () => {
  const a = fakeDesktop({ holdHandshake: true });
  const connecting = a.client.connect();
  assert.equal(a.client.ready, false);
  await assert.rejects(a.client.call('list_threads', {}), { code: 'DESKTOP_DISCONNECTED' });
  a.client.disconnect();
  await assert.rejects(connecting, { code: 'DESKTOP_DISCONNECTED' }); await a.client.close();
  const b = fakeDesktop({ holdExit: true });
  await b.client.connect();
  const closing = b.client.close();
  assert.equal(b.client.ready, false);
  await assert.rejects(b.client.call('list_threads', {}), { code: 'DESKTOP_DISCONNECTED' });
  b.child.kill(); await closing;
});

test('parseable invalid desktop envelopes disconnect instead of throwing while staying ready', async () => {
  for (const invalid of [null, [], {}, { id: 1 }, { jsonrpc: '1.0', id: 1, result: {} }]) {
    const { client, child } = fakeDesktop(); await client.connect();
    assert.doesNotThrow(() => child.stdout.write(JSON.stringify(invalid) + '\n'));
    assert.equal(client.ready, false); assert.equal(client.closed, true);
    await client.close();
  }
});
