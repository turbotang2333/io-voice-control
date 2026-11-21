import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openJournal } from './journal.mjs';
import { createQueueGateway } from './gateway.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const otherThread = '22222222-2222-4222-8222-222222222222';
function fixture(t, options = {}) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'queue-'));
  const file = join(root, 'journal.json');
  let journal = openJournal(file, threadId);
  t.after(() => {
    journal.close();
    assert.ok(resolve(root).startsWith(resolve(parent) + '\\'));
    rmSync(root, { recursive: true, force: true });
  });
  let online = true, calls = 0, mode = options.mode ?? 'complete', clientId;
  const client = {
    threadId,
    isDesktopAvailable: () => online,
    async snapshot() { return { id: threadId, name: '测试对话', status: { type: 'notLoaded' } }; },
    async turns() {
      if (mode === 'lost-ack') return [];
      if (!clientId) return [{ id: 'old', status: 'completed', items: [] }];
      return [{ id: 'new', status: mode === 'working' ? 'inProgress' : mode === 'failed' ? 'failed' : 'completed', items: [
        { type: 'userMessage', id: 'user', clientId: mode === 'unrelated' ? 'someone-else' : clientId,
          content: [{ type: 'text', text: '测试问题' }] },
        { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '测试回复' },
      ] }];
    },
    async queued() { return mode === 'queued' && clientId ? [{ id: 'q', clientUserMessageId: clientId }] : []; },
    async enqueue(text, id) {
      calls++; clientId = id;
      assert.equal(text, '测试问题');
      if (mode === 'lost-ack') throw Object.assign(new Error(), { code: 'DISCONNECTED' });
      return { id: 'q', clientUserMessageId: id };
    },
  };
  const make = () => createQueueGateway(client, { journal, timeoutMs: 0, pollMs: 1, wakeQueued: options.wakeQueued,
    ...options.gateway });
  return { client, file, make, calls: () => calls, offline: () => { online = false; },
    close: () => journal.close(),
    mode: value => { mode = value; },
    restart() { journal.close(); journal = openJournal(file, threadId); return make(); } };
}

test('submits once and reads only the reply linked by client message identity', async t => {
  const f = fixture(t), gateway = f.make();
  assert.deepEqual(await gateway.submit({ requestId: 'one', text: '测试问题' }),
    { requestId: 'one', status: 'idle', text: '测试回复' });
  assert.equal(f.calls(), 1);
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /测试问题|测试回复/);
});

test('default Codex wait survives a four-minute task and still submits only once', async t => {
  let time = 0;
  const f = fixture(t, { mode: 'working', gateway: { timeoutMs: undefined, now: () => time,
    sleep: async () => { if (time >= 240000) f.mode('complete'); time += time ? 1 : 240000; } } });
  const result = await f.make().submit({ requestId: 'four-minutes', text: '测试问题' });
  assert.equal(result.status, 'idle'); assert.equal(result.text, '测试回复'); assert.equal(f.calls(), 1);
});

test('the deadline returns timeout while a native read is pending and never publishes its late reply', async t => {
  let release, reads = 0;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, { mode: 'working', gateway: { timeoutMs: 35, pollMs: 1, now: () => 0, sleep: async () => {} } }), original = f.client.turns;
  f.client.turns = async () => {
    if (++reads >= 3) await held;
    return original();
  };
  const frames = [], gateway = f.make(), input = { requestId: 'bounded', text: '测试问题', onUpdate: x => frames.push(x) };
  // Bound the old implementation too so a failing regression does not stall the suite.
  const emergency = setTimeout(release, 150); t.after(() => clearTimeout(emergency));
  const result = await gateway.submit(input);
  assert.equal(result.status, 'timeout'); assert.match(result.text, /任务可能仍在执行/);
  assert.equal(f.calls(), 1);
  await assert.rejects(gateway.submit({ requestId: 'other', text: '测试问题' }), { code: 'CODEX_BUSY' });
  const before = frames.length; f.mode('complete'); release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(frames.length, before, 'late RPC replies cannot reach the closed lens request');
  assert.equal((await gateway.submit(input)).status, 'idle'); assert.equal(f.calls(), 1);
});

test('time spent preparing a snapshot counts toward the deadline and cannot cause a late send', async t => {
  let release; const held = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = fixture(t, { gateway: { timeoutMs: 20 } }), original = f.client.snapshot;
  f.client.snapshot = async () => { await held; return original(); };
  const emergency = setTimeout(release, 120); t.after(() => clearTimeout(emergency));
  const result = await f.make().submit({ requestId: 'preflight-timeout', text: '测试问题' });
  assert.equal(result.status, 'timeout'); assert.equal(f.calls(), 0);
  release(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls(), 0);
});

test('progress belongs to the accepted native turn, starts before text and reports a live tool once', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 10, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => {
    if (turn.id !== 'new') return turn;
    const done = ++stage >= 4;
    return { ...turn, status: done ? 'completed' : 'inProgress', items: [
      ...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'intro', phase: 'commentary', text: '开始。' },
      ...(stage >= 2 ? [{ type: 'commandExecution', id: 'tool', status: done ? 'completed' : 'inProgress', aggregatedOutput: '不能传到手机' }] : []),
      ...(done ? [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '完成。' }] : []),
    ] };
  });
  const result = await f.make().submit({ requestId: 'progress', text: '测试问题', onUpdate: x => frames.push(x) });
  assert.equal(result.status, 'idle');
  assert.deepEqual(frames.filter(x => x.type === 'state'), [{ type: 'state', state: 'working' }, { type: 'state', state: 'tool' }]);
  assert.deepEqual(frames[0], { type: 'state', state: 'working' });
  assert.doesNotMatch(JSON.stringify(frames), /不能传到手机/);
});

test('queued input and unrelated native turns never claim the glasses request is working', async t => {
  for (const mode of ['queued', 'unrelated']) {
    let time = 0;
    const f = fixture(t, { mode, gateway: { timeoutMs: 2, now: () => time, sleep: async () => { time++; } } }), original = f.client.turns, frames = [];
    if (mode === 'queued') f.client.turns = async () => [];
    else f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn, status: 'inProgress', items: [...turn.items,
      { type: 'mcpToolCall', id: 'foreign-tool', status: 'inProgress' }] }));
    await f.make().submit({ requestId: 'not-accepted-' + mode, text: '测试问题', onUpdate: x => frames.push(x) });
    assert.deepEqual(frames, []);
  }
});

test('tool progress requires a recognized native tool with an open lifecycle', async t => {
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']) {
    for (const status of ['inProgress', 'completed', 'declined']) {
      const f = fixture(t, { mode: 'working' }), original = f.client.turns, frames = [];
      f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
        items: [...turn.items.filter(i => i.type === 'userMessage'), { type, id: 'tool', status }] }));
      await f.make().submit({ requestId: 'native-tool', text: '测试问题', onUpdate: x => frames.push(x) });
      assert.deepEqual(frames.map(x => x.state), status === 'inProgress' ? ['working', 'tool'] : ['working']);
    }
  }
});

test('sleep activity is a tool only while its native lifecycle is open, never inferred as permission', async t => {
  for (const completedAtMs of [null, 200]) {
    const f = fixture(t, { mode: 'working' }), original = f.client.turns, frames = [];
    f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
      items: [...turn.items.filter(i => i.type === 'userMessage'),
        { type: 'sleep', id: 'wait', durationMs: 15000, startedAtMs: 100, completedAtMs },
        { type: 'reasoning', id: 'private', summary: ['等待授权等普通文字不能当状态'] },
        { type: 'futureUnknownTool', id: 'unknown', status: 'inProgress' }] }));
    await f.make().submit({ requestId: 'sleep-' + completedAtMs, text: '测试问题', onUpdate: x => frames.push(x) });
    assert.deepEqual(frames, completedAtMs === null
      ? [{ type: 'state', state: 'working' }, { type: 'state', state: 'tool' }]
      : [{ type: 'state', state: 'working' }]);
  }
});

test('explicit terminal tool status overrides an absent persisted completion timestamp', async t => {
  const f = fixture(t, { mode: 'working' }), original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
    items: [...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'webSearch', id: 'search', status: 'completed', startedAtMs: 100, completedAtMs: null },
      { type: 'imageGeneration', id: 'image', status: 'failed', startedAtMs: 100, completedAtMs: null }] }));
  await f.make().submit({ requestId: 'terminal-tools', text: '测试问题', onUpdate: x => frames.push(x) });
  assert.deepEqual(frames, [{ type: 'state', state: 'working' }]);
});

test('a pending raw call can report tools before the native items API has a tool item', async t => {
  const f = fixture(t, { mode: 'working' }), original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
    items: turn.items.filter(i => i.type === 'userMessage') }));
  f.client.toolActivity = async id => { assert.equal(id, 'new'); return true; };
  await f.make().submit({ requestId: 'raw-tool', text: '测试问题', onUpdate: x => frames.push(x) });
  assert.deepEqual(frames, [{ type: 'state', state: 'working' }, { type: 'state', state: 'tool' }]);
});

test('a late tool-activity read cannot emit after navigation ownership changed', async t => {
  const f = fixture(t, { mode: 'working' }), frames = []; let stale = false;
  f.client.toolActivity = async () => { stale = true; return true; };
  const result = await f.make().submit({ requestId: 'stale-tool', text: '测试问题',
    assertCurrent() { if (stale) throw Error('stale'); }, onUpdate: x => frames.push(x) });
  assert.equal(result.status, 'unknown'); assert.deepEqual(frames, []);
});

test('verified approval is displayed while observing the same request until it completes', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 10, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
    status: ++stage < 4 ? 'inProgress' : 'completed' }));
  f.client.approvalActivity = async id => { assert.equal(id, 'new'); return stage < 3; };
  const result = await f.make().submit({ requestId: 'approval', text: '测试问题', onUpdate: x => frames.push(x) });
  assert.equal(result.status, 'idle'); assert.equal(result.text, '测试回复'); assert.equal(f.calls(), 1);
  assert.deepEqual(frames.filter(x => x.type === 'state'), [{ type: 'state', state: 'working' }, { type: 'state', state: 'permission' }]);
});

test('unavailable or stale approval observations never become permission events', async t => {
  for (const mode of ['unknown', 'error', 'stale']) {
    const f = fixture(t, { mode: 'working' }), frames = []; let changed = false;
    f.client.approvalActivity = async () => {
      if (mode === 'error') throw Error('offline');
      if (mode === 'stale') { changed = true; return true; }
      return undefined;
    };
    await f.make().submit({ requestId: 'approval-' + mode, text: '测试问题', onUpdate: x => frames.push(x),
      assertCurrent() { if (changed) throw Error('stale'); } });
    assert.equal(frames.some(x => x.state === 'permission'), false);
    if (mode === 'stale') assert.deepEqual(frames, []);
  }
});

test('a completed reply without a message item ID preserves the earlier final-only contract', async t => {
  const f = fixture(t), original = f.client.turns;
  f.client.turns = async () => (await original()).map(turn => ({ ...turn, items: turn.items.map(item => {
    if (item.type !== 'agentMessage') return item;
    const { id, ...withoutId } = item; return withoutId;
  }) }));
  assert.equal((await f.make().submit({ requestId: 'legacy-final', text: '测试问题' })).text, '测试回复');
});

test('persisted commentary appears before completion and final text extends it without duplicates or tool output', async t => {
  let time = 0, stage = 0, completed = false;
  const f = fixture(t, { gateway: { timeoutMs: 10, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => {
    if (turn.id !== 'new') return turn;
    stage++; completed = stage >= 4;
    return { ...turn, status: completed ? 'completed' : 'inProgress', items: [
      ...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'intro', phase: 'commentary', text: '先检查现状。' },
      { type: 'reasoning', id: 'private', text: '内部推理不应显示' },
      { type: 'commandExecution', id: 'tool', output: '工具输出不应显示' },
      ...(stage >= 3 ? [{ type: 'agentMessage', id: 'partial', phase: 'partial_answer', text: '已有初步结果。' }] : []),
      ...(completed ? [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '检查完成。' }] : []),
    ] };
  });
  const result = await f.make().submit({ requestId: 'stream', text: '测试问题', onUpdate: frame => {
    if (frame.type === 'text') frames.push({ ...frame, beforeCompletion: !completed });
  } });
  assert.equal(frames[0]?.beforeCompletion, true);
  assert.deepEqual(frames.map(x => x.text), ['先检查现状。', '先检查现状。\n\n已有初步结果。', '先检查现状。\n\n已有初步结果。\n\n检查完成。']);
  assert.equal(result.text, frames.at(-1).text); assert.equal(result.status, 'idle');
  assert.equal(f.calls(), 1); assert.doesNotMatch(JSON.stringify(frames), /内部推理|工具输出/);
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /先检查现状|检查完成/);
});

test('an unrelated client message cannot leak its early commentary to the glasses', async t => {
  const f = fixture(t, { mode: 'unrelated' }), original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn, status: 'inProgress', items: [...turn.items,
    { type: 'agentMessage', id: 'private-intro', phase: 'commentary', text: '其他来源的回复' }] }));
  assert.equal((await f.make().submit({ requestId: 'foreign-stream', text: '测试问题', onUpdate: frame => frames.push(frame) })).status, 'unknown');
  assert.equal(frames.some(x => x.type === 'text'), false);
});

test('streaming messages and completion remain within phone limits and preserve a monotonic prefix', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 5, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => {
    if (turn.id !== 'new') return turn;
    const done = ++stage > 1;
    return { ...turn, status: done ? 'completed' : 'inProgress', items: [
      ...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'long-intro', phase: 'commentary', text: '🌍'.repeat(6000) },
      ...(done ? [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '完成。' }] : []),
    ] };
  });
  const result = await f.make().submit({ requestId: 'long-stream', text: '测试问题', onUpdate: frame => {
    if (frame.type === 'text') frames.push(frame.text);
  } });
  assert.ok(frames[0]?.length <= 2048); assert.ok(result.text.length <= 8192);
  assert.ok(frames.every((text, i) => i === 0 || text.startsWith(frames[i - 1])));
  assert.match(result.text, /完整回复请在原客户端查看/);
  assert.ok(frames.every(text => !/[\uD800-\uDBFF]$/.test(text)));
});

test('a turn identity changing after an early reply cannot finish another native turn as this request', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 5, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => {
    if (turn.id !== 'new') return turn;
    const done = ++stage > 1;
    return { ...turn, id: done ? 'different-turn' : 'new', status: done ? 'completed' : 'inProgress', items: [
      ...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'intro', phase: 'commentary', text: '已开始。' },
      ...(done ? [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '不应显示。' }] : []),
    ] };
  });
  const result = await f.make().submit({ requestId: 'changed-turn', text: '测试问题', onUpdate: frame => {
    if (frame.type === 'text') frames.push(frame.text);
  } });
  assert.equal(result.status, 'unknown'); assert.deepEqual(frames, ['已开始。']);
});

test('changing navigation while reading a running reply cannot publish that reply to the old display', async t => {
  const f = fixture(t), original = f.client.turns, frames = []; let stale = false;
  f.client.turns = async () => (await original()).map(turn => { if (turn.id === 'new') stale = true; return turn; });
  const result = await f.make().submit({ requestId: 'stale-stream', text: '测试问题',
    assertCurrent() { if (stale) throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' }); },
    onUpdate: frame => frames.push(frame) });
  assert.equal(result.status, 'unknown'); assert.deepEqual(frames, []);
  assert.equal(f.calls(), 1);
});

test('growing persisted items and repeated snapshots append once even if completion omits the early item', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 10, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => {
    if (turn.id !== 'new') return turn;
    stage++; const done = stage >= 4;
    const intro = { type: 'agentMessage', id: 'intro', phase: 'partial_answer', text: stage === 1 ? '先检查' : '先检查现状。' };
    return { ...turn, status: done ? 'completed' : 'inProgress', items: [
      ...turn.items.filter(i => i.type === 'userMessage'),
      ...(done ? [{ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '完成。' }] : [intro, intro]),
    ] };
  });
  const result = await f.make().submit({ requestId: 'growing', text: '测试问题', onUpdate: frame => {
    if (frame.type === 'text') frames.push(frame.text);
  } });
  assert.deepEqual(frames, ['先检查', '先检查现状。', '先检查现状。\n\n完成。']);
  assert.equal(result.text, frames.at(-1)); assert.equal(result.status, 'idle'); assert.equal(f.calls(), 1);
});

test('a rewritten stable item is not silently appended or reported as a confirmed final answer', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 5, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
    status: 'inProgress', items: [...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'same-item', phase: 'commentary', text: ++stage === 1 ? '先检查。' : '改写后的其他内容。' }] }));
  const result = await f.make().submit({ requestId: 'rewritten', text: '测试问题', onUpdate: frame => {
    if (frame.type === 'text') frames.push(frame.text);
  } });
  assert.equal(result.status, 'unknown'); assert.deepEqual(frames, ['先检查。']);
});

test('growth inside an earlier item cannot rewrite text already followed by another displayed item', async t => {
  let time = 0, stage = 0;
  const f = fixture(t, { gateway: { timeoutMs: 5, now: () => time, sleep: async () => { time++; } } });
  const original = f.client.turns, frames = [];
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
    status: 'inProgress', items: [...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'first', phase: 'commentary', text: ++stage === 1 ? '检查' : '检查完成' },
      { type: 'agentMessage', id: 'second', phase: 'partial_answer', text: '已有结果' }] }));
  const result = await f.make().submit({ requestId: 'aggregate-rewrite', text: '测试问题', onUpdate: frame => {
    if (frame.type === 'text') frames.push(frame.text);
  } });
  assert.equal(result.status, 'unknown'); assert.deepEqual(frames, ['检查\n\n已有结果']);
});

test('an early native turn binding must be durable before any preview is sent', async t => {
  const f = fixture(t, { mode: 'working' }), original = f.client.turns, frames = []; let stored;
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn : ({ ...turn,
    items: [...turn.items.filter(i => i.type === 'userMessage'),
      { type: 'agentMessage', id: 'intro', phase: 'commentary', text: '已开始。' }] }));
  const journal = { threadId, get: () => stored ? { ...stored } : null, unresolved: () => false, pending: () => [],
    put(id, value) { if (value.status === 'working') throw Error('disk failure'); stored = { ...value }; } };
  const gateway = createQueueGateway(f.client, { journal, timeoutMs: 0 });
  assert.equal((await gateway.submit({ requestId: 'disk-failed', text: '测试问题', onUpdate: frame => frames.push(frame) })).status, 'unknown');
  assert.equal(frames.some(x => x.type === 'text'), false); assert.equal(stored.status, 'queued');
});

test('a queued creation is woken only after durable acknowledgement and can be woken after restart without resending', async t => {
  let wakes = 0, f;
  f = fixture(t, { mode: 'queued', wakeQueued: async () => {
    const saved = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(saved.requests.one.queueId, 'q'); wakes++;
  } });
  f.client.turns = async () => [];
  assert.equal((await f.make().submit({ requestId: 'one', text: '测试问题' })).status, 'queued');
  assert.ok(wakes > 0); const before = wakes;
  assert.equal((await f.restart().submit({ requestId: 'one', text: '测试问题' })).status, 'queued');
  assert.ok(wakes > before); assert.equal(f.calls(), 1);
});

test('a completed request is recovered after restart without another submission', async t => {
  const f = fixture(t);
  await f.make().submit({ requestId: 'one', text: '测试问题' });
  const result = await f.restart().submit({ requestId: 'one', text: '测试问题' });
  assert.equal(result.text, '测试回复'); assert.equal(f.calls(), 1);
});

test('lost acknowledgements remain uncertain and can be reconciled without resend', async t => {
  const f = fixture(t, { mode: 'lost-ack' }), g = f.make();
  assert.equal((await g.submit({ requestId: 'one', text: '测试问题' })).status, 'unknown');
  await assert.rejects(g.submit({ requestId: 'two', text: '测试问题' }), { code: 'OUTCOME_UNKNOWN' });
  f.mode('complete');
  assert.equal((await f.restart().submit({ requestId: 'one', text: '测试问题' })).status, 'idle');
  assert.equal(f.calls(), 1);
});

test('identical text from another source cannot be mistaken for this reply', async t => {
  const f = fixture(t, { mode: 'unrelated' });
  assert.equal((await f.make().submit({ requestId: 'one', text: '测试问题' })).status, 'unknown');
});

test('a queued message is reported as waiting rather than successful', async t => {
  const f = fixture(t, { mode: 'queued' });
  // A persisted turn must take precedence; simulate that no matching turn exists yet.
  f.client.turns = async () => [];
  const result = await f.make().submit({ requestId: 'one', text: '测试问题' });
  assert.equal(result.status, 'queued'); assert.match(result.text, /等待/);
  const next = f.restart();
  await assert.rejects(next.submit({ requestId: 'two', text: '测试问题' }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.calls(), 1);
});

test('desktop closure before dispatch does not queue work for a later restart', async t => {
  const f = fixture(t); f.offline();
  await assert.rejects(f.make().submit({ requestId: 'one', text: '测试问题' }), { code: 'DESKTOP_UNAVAILABLE' });
  assert.equal(f.calls(), 0);
});

test('a source session invalidated while checking readiness cannot dispatch', async t => {
  const f = fixture(t);
  await assert.rejects(f.make().submit({ requestId: 'one', text: '测试问题',
    assertCurrent() { throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' }); } }),
  { code: 'NAVIGATION_SESSION_STALE' });
  assert.equal(f.calls(), 0);
});

test('request identity cannot be reused with a different body', async t => {
  const f = fixture(t), g = f.make();
  await g.submit({ requestId: 'one', text: '测试问题' });
  await assert.rejects(g.submit({ requestId: 'one', text: '另一问题' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.calls(), 1);
});

test('only one service can own a journal, and its thread binding cannot change', t => {
  const f = fixture(t);
  assert.throws(() => openJournal(f.file, threadId), { code: 'CONNECTOR_LOCKED' });
  f.restart();
  // Binding is validated before attempting to take the active process lock.
  assert.throws(() => openJournal(f.file, otherThread), { code: 'JOURNAL_TARGET_MISMATCH' });
});

test('corrupt state fails closed rather than resetting duplicate protection', t => {
  const f = fixture(t); f.restart();
  writeFileSync(f.file, '{bad json');
  assert.throws(() => openJournal(f.file, threadId), { code: 'JOURNAL_INVALID' });
});

test('an active turn prevents another request from being queued', async t => {
  const f = fixture(t); f.client.turns = async () => [{ id: 'running', status: 'inProgress', items: [] }];
  await assert.rejects(f.make().submit({ requestId: 'one', text: '测试问题' }), { code: 'CODEX_BUSY' });
  assert.equal(f.calls(), 0);
});

test('an incompletely persisted desktop turn blocks the first connector request too', async t => {
  const f = fixture(t);
  f.client.turns = async () => [{ id: 'desktop-running', status: 'interrupted', completedAt: null, items: [] }];
  await assert.rejects(f.make().submit({ requestId: 'one', text: '测试问题' }), { code: 'CODEX_BUSY' });
  assert.equal(f.calls(), 0);
});

test('an older durably interrupted desktop turn does not block a new request', async t => {
  const f = fixture(t), original = f.client.turns;
  f.client.turns = async () => (await original()).map(turn => turn.id === 'old'
    ? { ...turn, status: 'interrupted', completedAt: 123 } : turn);
  assert.equal((await f.make().submit({ requestId: 'one', text: '测试问题' })).status, 'idle');
  assert.equal(f.calls(), 1);
});

test('partial or non-final model text is not reported as a completed reply', async t => {
  const f = fixture(t, { mode: 'working' });
  assert.equal((await f.make().submit({ requestId: 'one', text: '测试问题' })).status, 'working');
});

test('the gap between queue consumption and saved history does not end polling early', async t => {
  const f = fixture(t), original = f.client.turns;
  let reads = 0, time = 0;
  f.client.turns = async () => ++reads === 2 ? [] : original();
  const journal = openJournal(f.file + '.gap', threadId);
  const g = createQueueGateway(f.client, { journal, timeoutMs: 5, pollMs: 1,
    now: () => time, sleep: async () => { time++; } });
  try {
    const value = await g.submit({ requestId: 'gap', text: '测试问题' });
    assert.equal(value.status, 'idle'); assert.equal(f.calls(), 1);
  } finally { journal.close(); }
});

test('an unloaded reader interruption without a completion timestamp keeps waiting for the original writer', async t => {
  const f = fixture(t), original = f.client.turns;
  let reads = 0, time = 0;
  f.client.turns = async () => {
    const turns = await original();
    if (++reads === 2) {
      turns[0].status = 'interrupted'; turns[0].completedAt = null;
      turns[0].items = turns[0].items.filter(i => i.type === 'userMessage');
    }
    return turns;
  };
  const journal = openJournal(f.file + '.projection', threadId);
  const g = createQueueGateway(f.client, { journal, timeoutMs: 5, pollMs: 1,
    now: () => time, sleep: async () => { time++; } });
  try {
    const value = await g.submit({ requestId: 'projection', text: '测试问题' });
    assert.equal(value.status, 'idle'); assert.equal(value.text, '测试回复');
    assert.equal(f.calls(), 1);
  } finally { journal.close(); }
});

test('an interruption without durable completion remains uncertain and blocks another task', async t => {
  const f = fixture(t), original = f.client.turns;
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn :
    { ...turn, status: 'interrupted', completedAt: null, items: turn.items.filter(i => i.type === 'userMessage') });
  const g = f.make();
  assert.equal((await g.submit({ requestId: 'pending', text: '测试问题' })).status, 'working');
  await assert.rejects(g.submit({ requestId: 'other', text: '测试问题' }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.calls(), 1);
});

test('a durably finished interruption is reported as unsuccessful without another submission', async t => {
  const f = fixture(t), original = f.client.turns;
  f.client.turns = async () => (await original()).map(turn => turn.id !== 'new' ? turn :
    { ...turn, status: 'interrupted', completedAt: 123, items: turn.items.filter(i => i.type === 'userMessage') });
  assert.equal((await f.make().submit({ requestId: 'cancelled', text: '测试问题' })).status, 'failed');
  assert.equal(f.calls(), 1);
});

test('replaying a completed request outside the recent history cannot block new work', async t => {
  const f = fixture(t), g = f.make();
  await g.submit({ requestId: 'old', text: '测试问题' });
  f.client.turns = async () => [];
  assert.equal((await g.submit({ requestId: 'old', text: '测试问题' })).status, 'idle');
  await assert.doesNotReject(g.submit({ requestId: 'new', text: '测试问题' }));
  assert.equal(f.calls(), 2);
});

test('a later request first reconciles a timed-out predecessor without resending it', async t => {
  const f = fixture(t, { mode: 'working' }), g = f.make();
  assert.equal((await g.submit({ requestId: 'old', text: '测试问题' })).status, 'working');
  f.mode('complete');
  assert.equal((await g.submit({ requestId: 'new', text: '测试问题' })).status, 'idle');
  assert.equal(f.calls(), 2);
});

test('journal acquisition cannot overwrite a request committed just before the lock', t => {
  const f = fixture(t); f.close();
  const original = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function(path, ...args) {
    const value = original(path, ...args);
    if (path === f.file && !injected) {
      injected = true;
      const state = JSON.parse(Buffer.isBuffer(value) ? value.toString() : value);
      state.requests.last = { hash: 'a'.repeat(64), clientId: 'last-client', status: 'unknown' };
      writeFileSync(f.file, JSON.stringify(state));
    }
    return value;
  };
  syncBuiltinESMExports();
  let next;
  try { next = openJournal(f.file, threadId); assert.ok(next.get('last')); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); next?.close(); }
});

test('a dead owner lock can be recovered without clearing its duplicate records', async t => {
  const f = fixture(t);
  await f.make().submit({ requestId: 'done', text: '测试问题' });
  f.close();
  const script = "import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,owner:'dead-owner'}));";
  execFileSync(process.execPath, ['--input-type=module', '-e', script, f.file + '.lock'], { windowsHide: true });
  let next;
  try { next = openJournal(f.file, threadId); assert.equal(next.get('done').status, 'idle'); }
  finally { next?.close(); }
});

test('replaying a failed request outside recent history preserves its terminal outcome', async t => {
  const f = fixture(t, { mode: 'failed' }), g = f.make();
  assert.equal((await g.submit({ requestId: 'old', text: '测试问题' })).status, 'failed');
  f.client.turns = async () => [];
  assert.equal((await g.submit({ requestId: 'old', text: '测试问题' })).status, 'failed');
  await assert.doesNotReject(g.submit({ requestId: 'new', text: '测试问题' }));
  assert.equal(f.calls(), 2);
});
