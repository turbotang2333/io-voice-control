import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTurnGateway } from '../bridge/turns.mjs';

function slowTurn() {
  let sends = 0, waitMs, listener;
  const client = { agents: { ref: () => ({
    refresh: async () => ({ agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }),
    timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
    run: async (_text, options) => {
      listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'test-turn', item: { type: 'user_message', messageId: options.messageId } } });
      sends++; waitMs = options.timeoutMs;
      // Reproduce the observed 189-second tool turn without running tools or waiting.
      return options.timeoutMs < 189000
        ? { status: 'timeout', final: { id: 'a1' }, lastMessage: 'intermediate progress' }
        : { status: 'idle', final: { id: 'a1' }, lastMessage: 'final answer after several tools' };
    },
  }) } };
  return { client, result: () => ({ sends, waitMs }) };
}

test('Paseo deadline includes preparation and returns while a native operation is still pending', async t => {
  for (const phase of ['preflight', 'running']) {
    let release, listener, sends = 0;
    const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
    const handle = {
      async refresh() { if (phase === 'preflight') await held; return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }; },
      timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
      async run(_text, options) {
        sends++; listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'own', item: { type: 'user_message', messageId: options.messageId } } });
        await held; return { status: 'idle', final: { id: 'a1' }, lastMessage: 'late reply' };
      },
    };
    const emergency = setTimeout(release, 150); t.after(() => clearTimeout(emergency));
    const gateway = createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1', timeoutMs: 25, now: () => 0 });
    const input = { requestId: 'bounded', text: 'test' }, result = await gateway.submit(input);
    assert.equal(result.status, 'timeout'); assert.equal(result.text, null);
    assert.equal(sends, phase === 'running' ? 1 : 0);
    await assert.rejects(gateway.submit({ requestId: 'other', text: 'test' }), { code: 'AGENT_BUSY' });
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await gateway.submit(input), result);
    assert.equal(sends, phase === 'running' ? 1 : 0);
  }
});

test('a 189-second tool turn can deliver the final answer with one submission', async () => {
  const fixture = slowTurn();
  const gateway = createTurnGateway(fixture.client, { agentId: 'a1', workspaceId: 'w1' });
  const input = { requestId: 'slow-1', text: 'test task' };
  const result = await gateway.submit(input);
  assert.equal(result.status, 'idle');
  assert.equal(result.text, 'final answer after several tools');
  assert.deepEqual(await gateway.submit(input), result);
  assert.equal(fixture.result().sends, 1);
});

test('phone and HTTP deadlines leave time for the bridge final answer to arrive', async () => {
  const fixture = slowTurn();
  await createTurnGateway(fixture.client, { agentId: 'a1', workspaceId: 'w1' })
    .submit({ requestId: 'budget-1', text: 'test task' });
  const bridgeWait = fixture.result().waitMs;
  const phone = readFileSync(new URL('../android-addon/src/cn/yilu/rayneopaseo/ProbeAddon.java', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8');
  const taskMethods = phone.slice(phone.indexOf('private static void request(long generation'));
  const reads = [...taskMethods.matchAll(/setReadTimeout\((\d+)\)/g)].map(match => Number(match[1]));
  const connects = [...taskMethods.matchAll(/setConnectTimeout\((\d+)\)/g)].map(match => Number(match[1]));
  assert.equal(reads.length, 2, 'both native and continuous task paths must retain their read budgets');
  assert.equal(connects.length, 2);
  const read = Math.min(...reads), connect = Math.max(...connects);
  const navigation = readFileSync(new URL('../android-addon/src/cn/yilu/rayneopaseo/NavigationTransport.java', import.meta.url), 'utf8');
  const limit = name => {
    const match = navigation.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`));
    assert.ok(match, `missing navigation budget: ${name}`);
    return Number(match[1]);
  };
  const handshakeBudget = 2 * Math.max(...['USB', 'PUBLIC'].map(profile => limit(`${profile}_ATTEMPTS`)
    * (limit(`${profile}_CONNECT_TIMEOUT_MS`) + limit(`${profile}_READ_TIMEOUT_MS`))));
  const fallback = Number(phone.match(/"等待超时[^"\r\n]*"\),\s*(\d+)\);/)[1]);
  const http = Number(server.match(/server\.requestTimeout\s*=\s*(\d+)/)[1]);
  assert.ok(read >= 189000 + 15000, 'phone must outwait the observed slow task');
  assert.ok(read >= bridgeWait + 15000, 'phone must leave room for SDK and network overhead');
  assert.ok(fallback >= Math.max(...reads) + connect + handshakeBudget, 'display fallback must leave room for two handshake requests and the full task HTTP budget');
  assert.ok(http >= read, 'HTTP deadline must not preempt the phone');
});
