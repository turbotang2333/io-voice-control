import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openJournal } from './journal.mjs';
import { createQueueNavigation } from './navigation.mjs';

function fixture(t, options = {}) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'navigation-')), file = join(root, 'journal.json');
  let journal = openJournal(file, 'codex-navigation'), time = 0, seq = 0;
  const projects = Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}`, name: `项目${i + 1}`, roots: [{ path: `C:\\p${i + 1}` }] }));
  const threads = [{ id: 'a', name: '原对话 A', projectId: 'p1', cwd: 'C:\\p1' },
    { id: 'b', name: '原对话 B', projectId: 'p2', cwd: 'C:\\p2' }];
  const userTimes = new Map([['a', 1000], ['b', 2000]]);
  const turns = new Map(), dispatched = [];
  let gate;
  const client = {
    projectPage: async () => ({ data: structuredClone(projects), nextCursor: null }),
    threadPage: async () => ({ data: structuredClone(threads), nextCursor: null }),
    userTimePage: async id => ({ data: [{ items: [{ type: 'userMessage', startedAtMs: userTimes.get(id) }] }], nextCursor: null }),
    bindThread(id) {
      return Object.freeze({ threadId: id, isDesktopAvailable: () => true,
        snapshot: async () => structuredClone(threads.find(t => t.id === id)),
        turns: async () => turns.get(id) ?? [], queued: async () => [],
        async enqueue(text, clientId) {
          dispatched.push(id); if (gate) await gate;
          turns.set(id, [{ id: 'turn-' + dispatched.length, status: 'completed', items: [
            { type: 'userMessage', clientId, content: [{ type: 'text', text }] },
            { type: 'agentMessage', phase: 'final_answer', text: '回复' + id },
          ] }]);
          return { id: 'queued-' + dispatched.length, clientUserMessageId: clientId };
        },
      });
    },
  };
  const make = () => createQueueNavigation(client, { journal, now: () => time, gatewayOptions: { timeoutMs: 0 }, search: options.search, serverId: options.serverId, creation: options.creation, wake: options.wake });
  let nav = make();
  t.after(() => { journal.close(); assert.ok(resolve(root).startsWith(resolve(parent) + '\\')); rmSync(root, { recursive: true, force: true }); });
  return { client, threads, projects, userTimes, dispatched, get nav() { return nav; },
    send: (text, id = 'request-' + ++seq, extra = {}) => nav.submit({ requestId: id, text, ...extra }),
    expire: () => { time += 120001; },
    restart() { journal.close(); journal = openJournal(file, 'codex-navigation'); nav = make(); },
    hold() { let release; gate = new Promise(r => { release = r; }); return release; },
  };
}
async function choose(f, project = 1) {
  await f.send('列出项目'); await f.send(`选择 ${project}`);
  await f.send('列出 Agent'); await f.send('选择 一');
}

test('numbered project and thread selection sends into that original thread', async t => {
  const f = fixture(t); await choose(f);
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
  assert.equal((await f.send('请继续这个任务')).text, '回复a');
  assert.deepEqual(f.dispatched, ['a']);
});

test('selection survives restart while the spoken number list does not', async t => {
  const f = fixture(t); await choose(f); f.restart();
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
  assert.match((await f.send('选择 1')).text, /先列出/);
});

test('an existing unloaded conversation wakes only its own queued input after desktop restart', async t => {
  const calls = [];
  const f = fixture(t, { wake: { run: async id => calls.push(id) } });
  await choose(f); f.restart();
  const original = f.client.bindThread;
  const queues = [];
  f.client.bindThread = id => {
    const bound = original(id);
    return { ...bound, snapshot: async () => ({ ...await bound.snapshot(), status: { type: 'notLoaded' } }),
      queued: async () => structuredClone(queues),
      enqueue: async (text, clientId) => {
        f.dispatched.push(id);
        const queued = { id: 'pending', clientUserMessageId: clientId };
        queues.push(queued); return queued;
      } };
  };
  assert.equal((await f.send('只回复连接验证通过', 'after-restart')).status, 'queued');
  assert.ok(calls.length > 0); assert.ok(calls.every(id => id === 'a'));
  assert.deepEqual(f.dispatched, ['a']);
  const before = calls.length;
  queues[0].clientUserMessageId = 'someone-else';
  await f.send('只回复连接验证通过', 'after-restart');
  assert.equal(calls.length, before);
  assert.deepEqual(f.dispatched, ['a']);
});

test('numbers refer to the current five-item page and lists expire', async t => {
  const f = fixture(t);
  const first = await f.send('列出项目'); assert.doesNotMatch(first.text, /项目6/);
  await f.send('下一页'); assert.match((await f.send('选择 1')).text, /项目6/);
  await f.send('列出项目'); f.expire(); assert.match((await f.send('选择 1')).text, /先列出/);
});

test('an entry moved to another project is rejected before dispatch', async t => {
  const f = fixture(t); await choose(f);
  f.threads[0].projectId = 'p2'; f.threads[0].cwd = 'C:\\p2';
  assert.match((await f.send('请执行任务')).text, /变化|重新/);
  assert.equal(f.dispatched.length, 0);
});

test('a repeated task id stays bound to the original thread after switching projects', async t => {
  const f = fixture(t); await choose(f);
  await f.send('测试问题', 'task-one'); await choose(f, 2);
  assert.equal((await f.send('测试问题', 'task-one')).text, '回复a');
  assert.equal((await f.send('测试问题', 'task-two')).text, '回复b');
  assert.deepEqual(f.dispatched, ['a', 'b']);
});

test('replaying an old selection command cannot switch the current conversation', async t => {
  const f = fixture(t);
  await f.send('列出项目'); await f.send('选择 1', 'old-selection');
  await choose(f, 2); await f.send('选择 1', 'old-selection');
  assert.match((await f.send('当前 Agent')).text, /原对话 B/);
});

test('a changed phone session cannot commit a selection', async t => {
  const f = fixture(t); await f.send('列出项目');
  let calls = 0;
  await assert.rejects(f.send('选择 1', undefined, { assertCurrent() {
    if (++calls > 1) throw Object.assign(new Error(), { code: 'NAVIGATION_SESSION_STALE' });
  } }), { code: 'NAVIGATION_SESSION_STALE' });
  assert.match((await f.send('当前项目')).text, /先选择|不可用/);
});

test('a running phone task prevents a concurrent selection change', async t => {
  const f = fixture(t); await choose(f); const release = f.hold();
  const task = f.send('测试问题');
  while (!f.dispatched.length) await new Promise(r => setImmediate(r));
  assert.match((await f.send('列出项目')).text, /执行|等待/);
  release(); assert.equal((await task).status, 'idle');
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
});

test('the final gateway preflight also rejects a conversation moved to another project', async t => {
  const f = fixture(t); await choose(f);
  const original = f.client.bindThread;
  let snapshots = 0;
  f.client.bindThread = id => {
    const bound = original(id);
    return { ...bound, snapshot: async () => {
      const value = await bound.snapshot();
      if (++snapshots > 1) value.projectId = 'p2';
      return value;
    } };
  };
  const reply = await f.send('测试问题');
  assert.match(reply.text, /归属|变化|重新/);
  assert.equal(f.dispatched.length, 0);
});

test('recent conversations work without a current project and select both project and original thread', async t => {
  const f = fixture(t);
  const list = await f.send('最近对话');
  assert.match(list.text, /最近对话/); assert.match(list.text, /1\.项目2：原对话 B/);
  assert.match((await f.send('选择 一')).text, /项目2/);
  assert.match((await f.send('当前项目')).text, /项目2/);
  assert.match((await f.send('当前 Agent')).text, /原对话 B/);
  assert.equal(f.dispatched.length, 0);
  assert.equal((await f.send('测试问题')).text, '回复b');
  assert.deepEqual(f.dispatched, ['b']);
});

test('recent selection can cross the current project but cannot follow a moved entry', async t => {
  const f = fixture(t); await choose(f);
  await f.send('最近对话');
  f.threads[1].projectId = 'p3'; f.threads[1].cwd = 'C:\\p3';
  assert.match((await f.send('选择 1')).text, /变化|重新/);
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
  assert.equal(f.dispatched.length, 0);
});

test('recent numbering stays attached to the shown five-item page even when recency changes', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 6; i++) {
    f.threads.push({ id: `r${i}`, name: `最近${i}`, projectId: 'p1', cwd: 'C:\\p1' });
    f.userTimes.set(`r${i}`, 10000 + i);
  }
  await f.send('最近对话'); await f.send('下一页');
  f.userTimes.set('b', 999999);
  assert.match((await f.send('选择 1')).text, /最近1/);
  assert.equal(f.dispatched.length, 0);
});

test('a recent list expires and is not restored after restart', async t => {
  const f = fixture(t); await f.send('最近对话'); f.expire();
  assert.match((await f.send('选择 1')).text, /先列出/);
  await f.send('最近对话'); f.restart();
  assert.match((await f.send('选择 1')).text, /先列出/);
});

test('recent lists explicitly report missing user times', async t => {
  const f = fixture(t); f.userTimes.delete('b');
  const response = await f.send('最近对话');
  assert.match(response.text, /部分/); assert.doesNotMatch(response.text, /原对话 B/);
  assert.match((await f.send('选择 1')).text, /原对话 A/);
});

test('a failed replacement recent read cannot leave an older number list selectable', async t => {
  const f = fixture(t); await f.send('列出项目');
  const original = f.client.projectPage;
  f.client.projectPage = async () => { throw new Error('read unavailable'); };
  await assert.rejects(f.send('最近对话'));
  f.client.projectPage = original;
  assert.match((await f.send('选择 1')).text, /先列出/);
});

test('search commands are local even when the optional search backend is unavailable', async t => {
  const f = fixture(t); await choose(f);
  assert.match((await f.send('查找对话手机提醒')).text, /未开启|尚未开启|不支持/);
  assert.equal(f.dispatched.length, 0);
});

function fakeSearch() {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, agentId: id,
    workspaceId: id === 'b' ? 'p2' : 'p1', workspaceName: id === 'b' ? '项目2' : '项目1', name: `搜索${i + 1}`, bodyCoverage: 'complete' }));
  let lastScope, snapshot, reads = 0, resolved = 0;
  const search = { async search(query, { scopeKey, assertCurrent }) {
    assert.equal(query, '手机提醒'); assertCurrent(); reads++; lastScope = scopeKey;
    snapshot = { items, coverage: 'complete', semanticAvailable: true }; return snapshot;
  }, async resolve({ snapshot: value, itemIndex, scopeKey }) {
    assert.equal(value, snapshot); assert.equal(scopeKey, lastScope); resolved++;
    return items[itemIndex];
  } };
  return { search, items, reads: () => reads, resolved: () => resolved };
}
function searchFixture(t) {
  const s = fakeSearch(), f = fixture(t, { search: s.search });
  for (const id of ['c', 'd', 'e']) f.threads.push({ id, name: id, projectId: 'p1', cwd: 'C:\\p1' });
  return { ...f, s };
}

test('search displays only two candidates per page and selecting a result changes both project and original thread', async t => {
  const f = searchFixture(t);
  const list = await f.send('查询对话手机提醒');
  assert.match(list.text, /搜索结果/); assert.match(list.text, /搜索2/); assert.doesNotMatch(list.text, /搜索3/);
  assert.match((await f.send('选择 3')).text, /没有这个编号/);
  assert.match((await f.send('选择 2')).text, /原对话 B|搜索2/);
  assert.match((await f.send('当前项目')).text, /项目2/);
  assert.match((await f.send('当前 Agent')).text, /原对话 B/);
  assert.equal(f.s.resolved(), 1); assert.equal(f.dispatched.length, 0);
});

test('search paging preserves the displayed candidate identity and never sends a model request', async t => {
  const f = searchFixture(t); await f.send('查找对话手机提醒');
  assert.match((await f.send('下一页')).text, /搜索3/);
  assert.match((await f.send('选择 1')).text, /搜索3|Agent：c/);
  assert.equal(f.dispatched.length, 0);
});

test('bare and overlong search commands do not invoke the search backend or a model', async t => {
  const f = searchFixture(t); await choose(f);
  assert.match((await f.send('查找对话')).text, /补充|主题/);
  assert.match((await f.send('查找对话' + '长'.repeat(201))).text, /太长/);
  assert.equal(f.s.reads(), 0); assert.equal(f.dispatched.length, 0);
});

test('stale search snapshots cannot change selection or deliver a model request', async t => {
  const s = fakeSearch(); s.search.resolve = async () => { throw Object.assign(new Error(), { code: 'SEARCH_STALE' }); };
  const f = fixture(t, { search: s.search }); await choose(f); await f.send('查找对话手机提醒');
  assert.match((await f.send('选择 2')).text, /失效|变化|重新/);
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
  assert.equal(f.dispatched.length, 0);
});

test('a shortcut selects an original thread across projects and a replay never reselects', async t => {
  const f = fixture(t, { serverId: 'codex-test-host' }); await choose(f);
  const target = await f.nav.resolveShortcut({ kind: 'agent', agentId: 'b' });
  const switched = await f.send('快捷切换', 'shortcut-1', { shortcut: target });
  assert.equal(switched.shortcutApplied, true);
  assert.match((await f.send('当前 Agent')).text, /原对话 B/);
  await choose(f); f.restart();
  assert.notEqual((await f.send('快捷切换', 'shortcut-1', { shortcut: target })).shortcutApplied, true);
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
  await assert.rejects(f.send('快捷切换', 'shortcut-1', { shortcut: { ...target, agentId: 'a' } }), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.dispatched.length, 0);
});

test('a project shortcut clears the old thread and displays only the new project conversations', async t => {
  const f = fixture(t, { serverId: 'codex-test-host' }); await choose(f);
  const target = await f.nav.resolveShortcut({ kind: 'workspace', agentId: 'b' });
  const reply = await f.send('快捷切换', undefined, { shortcut: target });
  assert.equal(reply.shortcutApplied, true); assert.match(reply.text, /原对话 B/); assert.doesNotMatch(reply.text, /原对话 A/);
  assert.match((await f.send('当前 Agent')).text, /不可用|先选择/);
  await f.send('选择 1'); assert.match((await f.send('当前 Agent')).text, /原对话 B/);
  assert.equal(f.dispatched.length, 0);
});

test('an invalid or foreign shortcut leaves selection unchanged and never becomes a model question', async t => {
  const f = fixture(t, { serverId: 'codex-test-host' }); await choose(f);
  for (const target of [null, { kind: 'agent', serverId: 'foreign', workspaceId: 'p2', agentId: 'b' }]) {
    const reply = await f.send('快捷切换', undefined, { shortcut: target });
    assert.notEqual(reply.shortcutApplied, true);
    assert.match((await f.send('当前 Agent')).text, /原对话 A/);
  }
  assert.equal(f.dispatched.length, 0);
});

test('a shortcut target becoming non-interactive at the final check cannot change selection', async t => {
  for (const change of [{ canAcceptDirectInput: false }, { ephemeral: true }, { source: { subAgent: {} } }]) {
    const f = fixture(t, { serverId: 'codex-test-host' }); await choose(f);
    const target = await f.nav.resolveShortcut({ kind: 'agent', agentId: 'b' });
    const original = f.client.bindThread; let reads = 0;
    f.client.bindThread = id => {
      const bound = original(id);
      return { ...bound, snapshot: async () => ({ ...await bound.snapshot(), ...(id === 'b' && ++reads > 1 ? change : {}) }) };
    };
    const reply = await f.send('快捷切换', undefined, { shortcut: target });
    assert.notEqual(reply.shortcutApplied, true);
    assert.match((await f.send('当前 Agent')).text, /原对话 A/);
    assert.equal(f.dispatched.length, 0);
  }
});

test('a shortcut cannot switch away from a task whose outcome is unknown', async t => {
  const f = fixture(t, { serverId: 'codex-test-host' }); await choose(f);
  const original = f.client.bindThread;
  f.client.bindThread = id => ({ ...original(id), enqueue: async () => { throw new Error('lost acknowledgement'); } });
  assert.equal((await f.send('测试问题')).status, 'unknown');
  const target = await f.nav.resolveShortcut({ kind: 'agent', agentId: 'b' });
  const reply = await f.send('快捷切换', undefined, { shortcut: target });
  assert.notEqual(reply.shortcutApplied, true);
  assert.match((await f.send('当前 Agent')).text, /原对话 A/);
});

test('voice creation names an empty thread in the current project, selects it, and a replay cannot recreate it', async t => {
  let creates = 0, f;
  const creation = { supported: () => true, async create(input) {
    assert.equal(input.title, '新的方案'); assert.equal(input.projectId, 'p1'); input.assertCurrent(); creates++;
    f.threads.push({ id: 'new-thread', name: input.title, projectId: 'p1', cwd: 'C:\\p1' });
    return { threadId: 'new-thread', projectId: 'p1', name: input.title };
  } };
  f = fixture(t, { creation }); await choose(f);
  const reply = await f.send('新建对话 新的方案', 'create-one');
  assert.match(reply.text, /已创建|已新建/); assert.match((await f.send('当前 Agent')).text, /新的方案/);
  await f.send('新建对话 新的方案', 'create-one'); assert.equal(creates, 1); assert.equal(f.dispatched.length, 0);
});

test('a phone can preview the currently selected Codex shortcut without copying a technical thread ID', async t => {
  const f = fixture(t, { serverId: 'codex-test-host' }); await choose(f);
  const agent = await f.nav.resolveShortcut({ kind: 'agent', useCurrent: true });
  assert.equal(agent.agentId, 'a'); assert.equal(agent.workspaceId, 'p1');
  const project = await f.nav.resolveShortcut({ kind: 'workspace', useCurrent: true });
  assert.equal(project.workspaceId, 'p1'); assert.equal(project.agentId, undefined);
  assert.match((await f.send('当前 Agent')).text, /原对话 A/); assert.equal(f.dispatched.length, 0);
});
