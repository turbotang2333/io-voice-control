import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../bridge/paseo-connection.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('one underlying daemon supplies API and lossless status subscription, with cleanup on close', async () => {
  assert.equal(typeof api.createPaseoConnection, 'function');
  let instances = 0, listener, unsubscribed = 0, disposed = 0, closed = 0;
  class Daemon {
    constructor(config) { instances++; this.config = config; this.state = { status: 'idle' }; }
    subscribeConnectionStatus(callback) { listener = callback; return () => { unsubscribed++; }; }
    getConnectionState() { return this.state; }
    ensureConnected() {}
    async close() { closed++; }
    async connect() {}
  }
  let daemon;
  const client = api.createPaseoConnection({ url: 'ws://127.0.0.1:6767/ws' }, {
    Daemon, createApi: value => { daemon = value; return { agents: {}, async dispose() { disposed++; } }; },
  });
  const events = [];
  client.subscribeConnectionStatus(value => events.push(value.status));
  for (const status of ['connecting', 'connected', 'disconnected', 'connecting', 'connected']) {
    daemon.state = { status }; listener(daemon.state);
  }
  assert.deepEqual(events, ['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
  assert.equal(instances, 1);
  await client.close();
  assert.equal(unsubscribed, 1); assert.equal(disposed, 1); assert.equal(closed, 1);
});

test('creation capability requires both modern lifecycle and keyed receipts from the same connected daemon', () => {
  let info;
  class Daemon {
    subscribeConnectionStatus() { return () => {}; }
    getLastServerInfoMessage() { return info; }
  }
  const client = api.createPaseoConnection({}, { Daemon, createApi: () => ({}) });
  assert.equal(client.supportsAgentCreation(), false);
  info = { features: { creationLifecycle: true } };
  assert.equal(client.supportsAgentCreation(), false);
  info.features.agentRequestReceipts = true;
  assert.equal(client.supportsAgentCreation(), true);
});

test('a short SDK disconnect and reconnect invalidates a pending recent resolve before it can save', async () => {
  const { createVoiceGateway } = await import('../bridge/voice-selection.mjs');
  let notify, daemon, release, entered, saved = 0, disposed = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  class Daemon {
    constructor() { daemon = this; this.state = { status: 'connected' }; }
    subscribeConnectionStatus(callback) { notify = callback; return () => { disposed++; }; }
    getConnectionState() { return this.state; }
    async close() {} ensureConnected() {}
  }
  let hold = false;
  const agent = { id: 'a', workspaceId: 'w', title: '会话', status: 'idle', lastUserMessageAt: '2026-10-29T00:00:00Z' };
  const client = api.createPaseoConnection({}, { Daemon, createApi: () => ({
    workspaces: { list: async () => ({ entries: [{ id: 'w', title: '项目', project: { projectKey: 'p' } }], pageInfo: {} }) },
    agents: { list: async () => ({ entries: [{ agent }], pageInfo: {} }), ref: () => ({ async refresh() {
      if (hold) { entered(); await waiting; } return { agent };
    } }) }, async dispose() {},
  }) });
  const gateway = createVoiceGateway(client, { agentId: 'a', workspaceId: 'w', stateStore: {
    getSelection: () => null, reserveRequest() {}, findRequest: () => null, saveSelection() { saved++; },
  } });
  const off = client.subscribeConnectionStatus(() => gateway.invalidateListing());
  await gateway.submit({ requestId: 'list', text: '最近对话' });
  hold = true;
  const pending = gateway.submit({ requestId: 'choose', text: '选择 1' }); await started;
  for (const status of ['disconnected', 'connecting', 'connected']) { daemon.state = { status }; notify(daemon.state); }
  release(); assert.doesNotMatch((await pending).text, /已选择/); assert.equal(saved, 0);
  assert.match((await gateway.submit({ requestId: 'old-number', text: '选择 1' })).text, /先.*列出/);
  off(); await client.close(); assert.equal(disposed, 1);
});
