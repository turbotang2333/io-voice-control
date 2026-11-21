import { createHash } from 'node:crypto';
import { createCodexGateway } from './gateway.mjs';
import { directoryKey, directoryName, label, readThreadMetadata } from './catalog.mjs';

const fail = code => Object.assign(new Error(code), { code });
function command(text) {
  const value = text.normalize('NFKC').replace(/\s+/gu, '').replace(/[，。！？；,.;!?]+$/u, '').replace(/^(?:请(?:帮我)?|帮我)/u, '');
  if (value.startsWith('新建对话')) return { type: 'create' };
  if (value === '当前项目') return { type: 'project' };
  if (/^当前(?:Agent|会话)$/iu.test(value)) return { type: 'thread' };
  if (/^(?:列出项目|项目列表)$/u.test(value)) return { type: 'projects' };
  if (/^(?:列出Agent|Agent列表|列出会话)$/iu.test(value)) return { type: 'threads' };
  if (/^(?:列出)?最近对话$/u.test(value)) return { type: 'recent' };
  if (value === '下一页' || value === '上一页') return { type: 'page', delta: value === '下一页' ? 1 : -1 };
  if (value === '口令帮助') return { type: 'help' };
  const selection = value.match(/^选择第?([0-9]+|[零〇一二两三四五六七八九十百]+)(?:个|项|号)?$/u);
  if (selection) return { type: 'select', value: selection[1] };
  return null;
}
function index(value) {
  if (/^[1-5]$/.test(value)) return Number(value) - 1;
  return ['一', '二', '三', '四', '五'].indexOf(value === '两' ? '二' : value);
}

export { command as parseCodexCommand, index as selectionIndex };

export async function createCodexNavigation(rpc, { state, cwd, createGateway = createCodexGateway }) {
  if (state.data.selection && (!directoryKey(state.data.selection.cwd)
      || (state.data.selection.threadId !== undefined && typeof state.data.selection.threadId !== 'string'))) throw fail('INVALID_STATE');
  let selected = state.data.selection ?? (state.data.threadId ? { cwd, threadId: state.data.threadId } : {});
  let listing = null, busy = false, uncertain = state.data.requests.some(r => r.kind !== 'control' && r.status === 'unknown');
  let listVersion = 0;
  const invalidateListing = () => { listing = null; listVersion++; };
  const cache = new Map(), gateways = new Map();
  const selection = value => {
    const previous = state.data.selection;
    state.data.selection = value;
    try { state.save(); }
    catch (error) { state.data.selection = previous; throw error; }
    selected = value; invalidateListing();
  };
  const control = (id, text) => ({ requestId: id, status: 'control', text });
  async function projects() {
    const result = [], seen = new Set();
    for (const thread of await readThreadMetadata(rpc)) {
      if (!seen.has(thread.key)) { seen.add(thread.key); result.push({ id: thread.key, cwd: thread.cwd, name: directoryName(thread.cwd) }); }
    }
    const counts = new Map();
    for (const p of result) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    for (const p of result) if (counts.get(p.name) > 1) p.name = label(p.cwd);
    return result;
  }
  const threads = () => selected.cwd ? readThreadMetadata(rpc, selected.cwd) : [];
  const find = async () => (await threads()).find(t => t.id === selected.threadId);
  const render = () => {
    const page = listing.items.slice(listing.page * 5, listing.page * 5 + 5);
    if (!page.length) return '名单为空，请选择其他项目。';
    return `${listing.type === 'projects' ? '项目' : 'Agent'}列表：\n`
      + page.map((item, i) => `${i + 1}.${item.name}${item.status === 'active' ? '（执行中）' : ''}`).join('\n')
      + '\n说选择 1 等当前页编号。' + (listing.items.length > 5 ? '可说下一页或上一页。' : '');
  };
  function setList(type, items) { listing = { type, items, page: 0, cwd: selected.cwd, expiresAt: Date.now() + 120000 }; return render(); }
  async function navigate(c, assertCurrent) {
    assertCurrent?.();
    if (['projects', 'threads'].includes(c.type)) invalidateListing();
    const version = listVersion;
    const check = () => { assertCurrent?.(); if (listVersion !== version) throw fail('NAVIGATION_SESSION_STALE'); };
    if (c.type === 'create') return '语音新建目前只支持Paseo模式，请先切换连接模式。';
    if (c.type === 'recent') return 'Codex暂不支持按最后发言时间列出最近对话，可说列出Agent。';
    if (c.type === 'help') return '可说当前项目、当前 Agent、列出项目、列出 Agent；先列出名单，再说选择 1 等编号。这里的 Agent 是 Codex 对话。';
    if (c.type === 'projects') { const items = await projects(); check(); return setList('projects', items); }
    if (c.type === 'project') {
      const current = (await projects()).find(p => p.id === directoryKey(selected.cwd));
      return current ? `当前项目：${current.name}。` : '当前项目不可用，请重新列出项目。';
    }
    if (c.type === 'thread') {
      if (!selected.threadId) return '请先选择 Agent，可说列出 Agent。';
      const current = await find();
      return current ? `项目：${directoryName(current.cwd)}。当前 Agent：${current.name}。` : '当前 Agent 已变化，请重新列出 Agent。';
    }
    if (c.type === 'threads') { const items = await threads(); check(); return selected.cwd ? setList('threads', items) : '请先选择项目，可说列出项目。'; }
    if (!listing || listing.expiresAt < Date.now() || (listing.type === 'threads' && directoryKey(listing.cwd) !== directoryKey(selected.cwd))) {
      listing = null; return '请先列出项目或列出 Agent，再按编号选择。';
    }
    if (c.type === 'page') {
      listing.page = Math.max(0, Math.min(Math.ceil(listing.items.length / 5) - 1, listing.page + c.delta));
      return render();
    }
    const number = index(c.value), item = number >= 0 ? listing.items[listing.page * 5 + number] : null;
    if (!item) return '当前页没有这个编号，请按显示的编号选择。';
    const items = listing.type === 'projects' ? await projects() : await threads();
    check();
    const fresh = items.find(t => t.id === item.id);
    if (!fresh) { listing = null; return '名单已变化，请重新列出后选择。'; }
    if (listing.type === 'projects') {
      selection({ cwd: fresh.cwd });
      return `已选择项目：${fresh.name}。请先选择 Agent，可说列出 Agent。`;
    }
    selection({ cwd: fresh.cwd, threadId: fresh.id });
    return `已选择 Agent：${fresh.name}。项目：${directoryName(fresh.cwd)}。`
      + (fresh.status === 'active' ? '该会话执行中，请等待。' : '当前实验只能续聊已在其他入口关闭的会话。');
  }
  return {
    invalidateListing,
    async submit(input = {}) {
      const { requestId, text } = input;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
          || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT');
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = state.data.requests.find(r => r.id === requestId);
      if (previous) {
        if (previous.hash !== hash) throw fail('REQUEST_CONFLICT');
        return cache.get(requestId) ?? (previous.kind === 'control'
          ? control(requestId, '此口令已处理，请重新说出口令。') : { requestId, status: 'unknown', text: null });
      }
      const c = command(text);
      input.assertCurrent?.();
      if (busy) return control(requestId, '已有任务执行中，请等完成后再选择或发送。');
      if (uncertain && c?.type === 'select') return control(requestId, '上一任务结果不明，请先在电脑核对，暂时不能切换会话。');
      if (uncertain && !c) throw fail('OUTCOME_UNKNOWN');
      if (state.data.requests.length >= 256) throw fail('EXPERIMENT_FULL');
      busy = true;
      const record = { id: requestId, hash, kind: c ? 'control' : 'task', status: c ? 'control' : 'unknown',
        ...(selected.threadId ? { threadId: selected.threadId } : {}) };
      try { state.data.requests.push(record); state.save(); }
      catch { busy = false; throw fail('STATE_WRITE_FAILED'); }
      const operation = Promise.resolve().then(async () => {
        input.assertCurrent?.();
        if (c) return control(requestId, await navigate(c, input.assertCurrent));
        if (!selected.cwd) return control(requestId, '请先选择项目，可说列出项目。');
        if (!selected.threadId) return control(requestId, '请先选择 Agent，可说列出 Agent。');
        const current = await find();
        input.assertCurrent?.();
        if (!current) return control(requestId, '当前项目或 Agent 已变化，请重新列出并选择。');
        if (current.status === 'active') return control(requestId, '当前 Agent 执行中，请等待完成。');
        const { thread } = await rpc.request('thread/read', { threadId: current.id, includeTurns: false });
        input.assertCurrent?.();
        if (thread?.id !== current.id || directoryKey(thread.cwd) !== current.key) return control(requestId, 'Agent 归属已变化，请重新列出并选择。');
        if (thread.status?.type === 'active') return control(requestId, '当前 Agent 执行中，请等待完成。');
        if (!gateways.has(current.id)) {
          const localState = { data: { version: 1, threadId: current.id, requests: [] }, save() {} };
          const gateway = await createGateway(rpc, { state: localState, cwd: current.cwd, preserveConfig: true, assertCurrent: input.assertCurrent });
          input.assertCurrent?.();
          gateways.set(current.id, gateway);
        }
        return gateways.get(current.id).submit(input);
      }).then(result => {
        record.status = result.status;
        if (['unknown', 'timeout'].includes(result.status)) uncertain = true;
        state.save();
        return result;
      }, error => {
        // Failure before a turn is started must not look like a successful send.
        record.status = 'control';
        if (error.code === 'THREAD_IN_USE') record.errorCode = 'THREAD_IN_USE';
        try { state.save(); } catch { /* Keep the pre-send record. */ }
        if (error.code === 'THREAD_IN_USE') return control(requestId, '所选会话仍由另一个 Codex 进程打开，本次未发送。请选择已在原入口关闭的历史会话，或使用独立测试会话。');
        return control(requestId, error.code === 'CODEX_BUSY' ? '当前 Agent 执行中，请等待完成。' : '未能核对 Codex 名单或会话，没有自动重发。请重新列出后选择。');
      }).finally(() => { busy = false; });
      cache.set(requestId, operation);
      return operation;
    },
  };
}
