import assert from 'node:assert/strict';
import test from 'node:test';
const load = () => import('../bridge/turns.mjs');

test('a native writer conflict before input is accepted reports definite non-delivery without replay', async () => {
  const { createTurnGateway } = await load();
  let attempts = 0, releases = 0;
  const handle = {
    refresh: async () => ({ agent: { id: 'a1', workspaceId: 'w1', status: 'closed' } }),
    timeline: { subscribe() { return { ready: Promise.resolve(), release() { releases++; } }; } },
    async run() {
      attempts++;
      throw Error('Failed to resume Codex thread 00000000-0000-0000-0000-000000000001: thread 00000000-0000-0000-0000-000000000001 already has an active writer');
    },
  };
  const gateway = createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' });
  for (let i = 0; i < 2; i++) await assert.rejects(gateway.submit({ requestId: 'one', text: 'test' }), error => {
    assert.equal(error.code, 'AGENT_TARGET_IN_USE');
    assert.match(error.message, /本次未发送/);
    assert.doesNotMatch(error.message, /00000000|writer/);
    return true;
  });
  assert.equal(attempts, 1); assert.equal(releases, 1);
});

test('uncertain failures and writer errors after accepted input retain unknown delivery', async () => {
  const { createTurnGateway } = await load();
  for (const mode of ['transport', 'accepted']) {
    let listener;
    const handle = {
      refresh: async () => ({ agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }),
      timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
      async run() {
        if (mode === 'accepted') {
          listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'own', item: { type: 'user_message', messageId: 'one' } } });
          listener({ agentId: 'a1', event: { type: 'error' } });
        }
        throw Error(mode === 'transport' ? 'connection interrupted' : 'Failed to resume Codex thread 00000000-0000-0000-0000-000000000001: thread 00000000-0000-0000-0000-000000000001 already has an active writer');
      },
    };
    const result = await createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
      .submit({ requestId: 'one', text: 'test' });
    assert.equal(result.status, 'unknown'); assert.equal(result.text, null);
  }
});

test('another user input or replaced timeline invalidates the final reply as well as its preview', async () => {
  const { createTurnGateway } = await load();
  for (const invalidate of ['foreign-input', 'foreign-before-own', 'replacement', 'subscription_restored', 'error']) {
    let listener;
    const handle = {
      async refresh() { return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }; },
      timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
      async run() {
        if (invalidate === 'foreign-before-own') listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'other', item: { type: 'user_message', messageId: 'foreign' } } });
        listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'own', item: { type: 'user_message', messageId: 'one' } } });
        listener({ agentId: 'a1', event: invalidate === 'foreign-input'
          ? { type: 'timeline', turnId: 'other', item: { type: 'user_message', messageId: 'foreign' } }
          : invalidate === 'foreign-before-own' ? { type: 'timeline', turnId: 'own', item: { type: 'assistant_message', text: 'own' } } : { type: invalidate } });
        return { status: 'idle', final: { id: 'a1' }, lastMessage: 'private other reply' };
      },
    };
    const result = await createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
      .submit({ requestId: 'one', text: 'test task', onUpdate() {} });
    assert.equal(result.status, 'unknown'); assert.equal(result.text, null);
  }
});

test('missing or failed task tracking prevents a send rather than returning an unbound last message', async () => {
  const { createTurnGateway } = await load();
  for (const broken of ['missing', 'failed']) {
    let sends = 0;
    const handle = { refresh: async () => ({ agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }),
      run: async () => { sends++; return { status: 'idle', final: { id: 'a1' }, lastMessage: 'unbound reply' }; } };
    if (broken === 'failed') handle.timeline = { subscribe() { throw Error('synthetic subscription failure'); } };
    await assert.rejects(createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
      .submit({ requestId: 'one', text: 'test task' }), { code: 'AGENT_TRACKING_UNAVAILABLE' });
    assert.equal(sends, 0);
  }
});

test('foreign activity while subscription becomes ready blocks the only send', async () => {
  const { createTurnGateway } = await load();
  let sends = 0;
  const handle = {
    refresh: async () => ({ agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }),
    timeline: { subscribe(fn) { return { ready: Promise.resolve().then(() => fn({ agentId: 'a1', event: {
      type: 'timeline', turnId: 'foreign-active-turn', item: { type: 'user_message', messageId: 'foreign' },
    } })), release() {} }; } },
    async run() { sends++; return { status: 'idle', final: { id: 'a1' }, lastMessage: 'mixed foreign reply' }; },
  };
  await assert.rejects(createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
    .submit({ requestId: 'one', text: 'test' }), { code: 'AGENT_BUSY' });
  assert.equal(sends, 0);
});

test('tracking lost during the final idle check prevents sending', async () => {
  const { createTurnGateway } = await load();
  for (const type of ['error', 'replacement', 'subscription_restored']) {
    let listener, refreshes = 0, sends = 0;
    const handle = {
      async refresh() {
        if (++refreshes === 2) listener({ agentId: 'a1', event: { type } });
        return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } };
      },
      timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
      async run() { sends++; return { status: 'idle', final: { id: 'a1' }, lastMessage: 'unbound' }; },
    };
    await assert.rejects(createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
      .submit({ requestId: 'one', text: 'test' }), { code: 'AGENT_TRACKING_UNAVAILABLE' });
    assert.equal(sends, 0);
  }
});

test('a dormant unarchived Paseo conversation may reload once before its own input, never across foreign input', async () => {
  const { createTurnGateway } = await load();
  for (const mode of ['own', 'foreign', 'late-reset']) {
    let listener, sends = 0;
    const handle = {
      refresh: async () => ({ agent: { id: 'a1', workspaceId: 'w1', status: 'closed', archivedAt: null, activeTurn: null, pendingPermissions: [] } }),
      timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
      async run(_text, options) {
        sends++;
        listener({ agentId: 'a1', event: { type: 'replacement' } });
        const user = messageId => listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'own', item: { type: 'user_message', messageId } } });
        if (mode === 'foreign') user('foreign');
        user(options.messageId);
        if (mode === 'late-reset') listener({ agentId: 'a1', event: { type: 'replacement' } });
        return { status: 'idle', final: { id: 'a1' }, lastMessage: mode === 'own' ? 'own reply' : 'unbound reply' };
      },
    };
    const result = await createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
      .submit({ requestId: 'one', text: 'test' });
    assert.equal(result.status, mode === 'own' ? 'idle' : 'unknown');
    assert.equal(result.text, mode === 'own' ? 'own reply' : null); assert.equal(sends, 1);
  }
});

test('session changes while timeline subscription is pending prevent the only run and release resources', async () => {
  const { createTurnGateway } = await load();
  let resolve, subscribed, released = 0, sends = 0, valid = true;
  const ready = new Promise(done => { resolve = done; });
  const entered = new Promise(done => { subscribed = done; });
  const client = sdk({ run: async () => { sends++; } });
  const ref = client.agents.ref;
  client.agents.ref = id => ({ ...ref(id), timeline: { subscribe() { subscribed(); return { ready, release() { released++; } }; } } });
  const gateway = createTurnGateway(client, { agentId: 'a1', workspaceId: 'w1' });
  const pending = gateway.submit({ requestId: 'guarded', text: '测试问题', onUpdate() {}, assertCurrent() {
    if (!valid) throw Object.assign(new Error('changed'), { code: 'NAVIGATION_SESSION_STALE' });
  } });
  await entered; valid = false; resolve();
  await assert.rejects(pending, { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(sends, 0); assert.equal(released, 1);
});

test('after the only Paseo run starts, a session change does not cancel tracking or permit replay', async () => {
  const { createTurnGateway } = await load();
  let finish, started, valid = true, sends = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const gateway = createTurnGateway(sdk({ run: async () => { sends++; started(); await done;
    return { status: 'idle', final: { id: 'a1' }, lastMessage: '已完成' }; } }), { agentId: 'a1', workspaceId: 'w1' });
  const input = { requestId: 'started', text: '测试问题', assertCurrent() { if (!valid) throw new Error('changed'); } };
  const pending = gateway.submit(input); await entered; valid = false; finish();
  assert.equal((await pending).status, 'idle');
  assert.equal((await gateway.submit(input)).status, 'idle'); assert.equal(sends, 1);
});

function sdk({ status = 'idle', permissions = [], workspaceId = 'w1', run, missing = false, activeTurn = null } = {}) {
  return { agents: { ref(id) {
    assert.equal(id, 'a1');
    let listener;
    const perform = run ?? (async (text, options) => {
      assert.equal(text, '测试问题');
      assert.equal(options.messageId, 'request-1'); assert.equal(options.activeTurnBehavior, 'steer');
      assert.ok(options.timeoutMs > 290000 && options.timeoutMs <= 300000);
      return { status: 'idle', final: { id: 'a1' }, lastMessage: '测试回复', error: null };
    });
    return {
      async refresh() { return missing ? null : { agent: { id, status, workspaceId, pendingPermissions: permissions, activeTurn } }; },
      timeline: { subscribe(fn) { listener = fn; return { ready: Promise.resolve(), release() {} }; } },
      async run(text, options) {
        listener?.({ agentId: id, event: { type: 'timeline', turnId: 'test-turn', item: { type: 'user_message', messageId: options.messageId } } });
        return perform(text, options);
      },
    };
  } } };
}

test('a turn keeps the selected agent identity and returns its final reply', async () => {
  const { createTurnGateway } = await load();
  const gateway = createTurnGateway(sdk(), { agentId: 'a1', workspaceId: 'w1' });
  assert.deepEqual(await gateway.submit({ requestId: 'request-1', text: '测试问题' }), {
    requestId: 'request-1', agentId: 'a1', status: 'idle', text: '测试回复',
  });
});

test('an explicit new request can resume an agent whose previous turn failed', async () => {
  const { createTurnGateway } = await load();
  const gateway = createTurnGateway(sdk({ status: 'error' }), { agentId: 'a1', workspaceId: 'w1' });
  const result = await gateway.submit({ requestId: 'request-1', text: '测试问题' });
  assert.equal(result.status, 'idle');
  assert.equal(result.text, '测试回复');
});

test('an active turn blocks submission even when the status snapshot says idle', async () => {
  const { createTurnGateway } = await load();
  const gateway = createTurnGateway(sdk({ activeTurn: { id: 'in-flight' }, run: () => assert.fail('must not send') }), { agentId: 'a1', workspaceId: 'w1' });
  await assert.rejects(gateway.submit({ requestId: 'request-1', text: '测试问题' }), { code: 'AGENT_BUSY' });
});

test('duplicate submissions share one send and the same result', async () => {
  const { createTurnGateway } = await load();
  let sends = 0;
  const gateway = createTurnGateway(sdk({ run: async () => {
    sends++;
    return { status: 'idle', final: { id: 'a1' }, lastMessage: '一次回复' };
  } }), { agentId: 'a1', workspaceId: 'w1' });
  const input = { requestId: 'request-1', text: '测试问题' };
  const [a, b] = await Promise.all([gateway.submit(input), gateway.submit(input)]);
  assert.deepEqual(a, b);
  assert.equal(sends, 1);
  await gateway.submit(input);
  assert.equal(sends, 1);
  await assert.rejects(gateway.submit({ ...input, text: '不同问题' }), { code: 'REQUEST_CONFLICT' });
});

test('running agents, workspace changes and permissions never receive a test prompt', async () => {
  const { createTurnGateway } = await load();
  for (const [options, code] of [
    [{ status: 'running' }, 'AGENT_BUSY'], [{ workspaceId: 'w2' }, 'WRONG_WORKSPACE'],
    [{ permissions: [{}] }, 'AGENT_NEEDS_PERMISSION'], [{ missing: true }, 'AGENT_NOT_FOUND'],
  ]) {
    const gateway = createTurnGateway(sdk({ ...options, run: () => assert.fail('must not send') }), { agentId: 'a1', workspaceId: 'w1' });
    await assert.rejects(gateway.submit({ requestId: 'request-1', text: '测试问题' }), { code });
  }
});

test('timeout and uncertain delivery are cached without a second send', async () => {
  const { createTurnGateway } = await load();
  for (const mode of ['timeout', 'connection-loss']) {
    let sends = 0;
    const gateway = createTurnGateway(sdk({ run: async () => {
      sends++;
      if (mode === 'connection-loss') throw new Error('private-network-detail');
      return { status: 'timeout', final: { id: 'a1' }, lastMessage: 'old-message' };
    } }), { agentId: 'a1', workspaceId: 'w1' });
    const input = { requestId: 'request-1', text: '测试问题' };
    const result = await gateway.submit(input);
    assert.equal(result.status, mode === 'timeout' ? 'timeout' : 'unknown');
    assert.equal(result.text, null);
    assert.deepEqual(await gateway.submit(input), result);
    assert.equal(sends, 1);
  }
});

test('a different agent in the final result never leaks its reply', async () => {
  const { createTurnGateway } = await load();
  const gateway = createTurnGateway(sdk({ run: async () => ({ status: 'idle', final: { id: 'a2' }, lastMessage: 'private-other-reply' }) }), { agentId: 'a1', workspaceId: 'w1' });
  const result = await gateway.submit({ requestId: 'request-1', text: '测试问题' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.text, null);
});

test('malformed or empty requests are rejected before touching the SDK', async () => {
  const { createTurnGateway } = await load();
  const gateway = createTurnGateway({}, { agentId: 'a1', workspaceId: 'w1' });
  for (const input of [{}, { requestId: 'id with spaces', text: 'x' }, { requestId: 'r1', text: ' ' }, { requestId: 'r1', text: 'x'.repeat(4097) }]) {
    await assert.rejects(gateway.submit(input), { code: 'INVALID_INPUT' });
  }
});

test('live updates include only the submitted turn and keep one copy of each assistant message', async () => {
  const { createTurnGateway } = await load();
  const updates = [];
  let listener, released = false;
  const handle = {
    async refresh() { return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }; },
    timeline: { subscribe(fn) {
      listener = fn;
      return Object.assign(() => { released = true; }, { ready: Promise.resolve() });
    } },
    async run(_text, options) {
      assert.ok(listener, 'subscribe before sending');
      assert.equal(options.messageId, 'request-1');
      let seq = 0;
      const event = (item, turnId = 'own', eventSeq = ++seq) => listener({ agentId: 'a1', seq: eventSeq, event: { type: 'timeline', item, turnId } });
      event({ type: 'assistant_message', messageId: 'old', text: '旧回复' }, 'old-turn');
      event({ type: 'user_message', messageId: 'request-1', text: '测试问题' });
      event({ type: 'assistant_message', messageId: 'one', text: '先处理' });
      const finalFragmentSeq = seq + 1;
      event({ type: 'assistant_message', messageId: 'one', text: '。' });
      event({ type: 'assistant_message', messageId: 'foreign', text: '别人的内容' }, 'other-turn');
      event({ type: 'tool_call', status: 'running', name: 'secret-tool', detail: { private: 'secret' } });
      event({ type: 'assistant_message', messageId: 'one', text: '。' }, 'own', finalFragmentSeq);
      event({ type: 'assistant_message', messageId: 'two', text: '已完成' });
      return { status: 'idle', final: { id: 'a1' }, lastMessage: '先处理。\n已完成' };
    },
  };
  const gateway = createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' });
  const result = await gateway.submit({ requestId: 'request-1', text: '测试问题', onUpdate: item => updates.push(item) });
  assert.deepEqual(updates, [
    { type: 'state', state: 'working' },
    { type: 'text', text: '先处理。' },
    { type: 'state', state: 'tool' },
  ]);
  assert.equal(result.text, '先处理。\n已完成');
  assert.equal(released, true);
});

test('first assistant sentence arrives before a long turn ends even without a tool event', async () => {
  const { createTurnGateway } = await load();
  const updates = [];
  let listener;
  const handle = {
    async refresh() { return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }; },
    timeline: { subscribe(fn) {
      listener = fn;
      return Object.assign(() => {}, { ready: Promise.resolve() });
    } },
    async run() {
      const event = item => listener({ agentId: 'a1', event: { type: 'timeline', turnId: 'own', item } });
      event({ type: 'user_message', messageId: 'request-1', text: '等待十秒' });
      event({ type: 'assistant_message', messageId: 'first', text: '我等 10 秒。' });
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.deepEqual(updates, [
        { type: 'state', state: 'working' },
        { type: 'text', text: '我等 10 秒。' },
      ]);
      event({ type: 'assistant_message', messageId: 'second', text: '\n\n---\n\n完成' });
      return { status: 'idle', final: { id: 'a1' }, lastMessage: '我等 10 秒。\n\n---\n\n完成' };
    },
  };
  const gateway = createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' });
  const result = await gateway.submit({ requestId: 'request-1', text: '等待十秒', onUpdate: update => updates.push(update) });
  assert.equal(result.text, '我等 10 秒。\n\n---\n\n完成');
  assert.equal(updates.filter(update => update.type === 'text').length, 1);
});

test('live reply keeps the first character when a message arrives as separate fragments', async () => {
  const { createTurnGateway } = await load();
  const updates = [];
  let listener;
  const handle = {
    async refresh() { return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }; },
    timeline: { subscribe(fn) {
      listener = fn;
      return Object.assign(() => {}, { ready: Promise.resolve() });
    } },
    async run() {
      const event = (seq, item) => listener({ agentId: 'a1', seq, event: { type: 'timeline', turnId: 'own', item } });
      event(1, { type: 'user_message', messageId: 'request-1', text: '测试问题' });
      event(2, { type: 'assistant_message', messageId: 'first', text: '明' });
      event(3, { type: 'assistant_message', messageId: 'first', text: '白，不发送。' });
      event(4, { type: 'tool_call', status: 'running' });
      return { status: 'idle', final: { id: 'a1' }, lastMessage: '明白，不发送。' };
    },
  };
  const result = await createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
    .submit({ requestId: 'request-1', text: '测试问题', onUpdate: update => updates.push(update) });
  assert.equal(result.text, '明白，不发送。');
  assert.deepEqual(updates.filter(update => update.type === 'text'), [{ type: 'text', text: '明白，不发送。' }]);
});

test('live fragments preserve repeated words and spaces while ignoring replayed events', async () => {
  const { createTurnGateway } = await load();
  const updates = [];
  let listener;
  const handle = {
    async refresh() { return { agent: { id: 'a1', workspaceId: 'w1', status: 'idle' } }; },
    timeline: { subscribe(fn) {
      listener = fn;
      return Object.assign(() => {}, { ready: Promise.resolve() });
    } },
    async run() {
      const event = (seq, item) => listener({ agentId: 'a1', seq, event: { type: 'timeline', turnId: 'own', item } });
      event(1, { type: 'user_message', messageId: 'request-1', text: '测试问题' });
      for (const [seq, text] of [[2, '哈'], [3, '哈'], [3, '哈'], [4, ' 好'], [5, ' '], [6, '呀。']]) {
        event(seq, { type: 'assistant_message', messageId: 'first', text });
      }
      event(7, { type: 'tool_call', status: 'running' });
      return { status: 'idle', final: { id: 'a1' }, lastMessage: '哈哈 好 呀。' };
    },
  };
  await createTurnGateway({ agents: { ref: () => handle } }, { agentId: 'a1', workspaceId: 'w1' })
    .submit({ requestId: 'request-1', text: '测试问题', onUpdate: update => updates.push(update) });
  assert.deepEqual(updates.filter(update => update.type === 'text'), [{ type: 'text', text: '哈哈 好 呀。' }]);
});
