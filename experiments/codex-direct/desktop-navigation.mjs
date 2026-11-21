import { createHash } from 'node:crypto';
import { parseCodexCommand, selectionIndex } from './navigation.mjs';
import { createDesktopGateway } from './desktop-gateway.mjs';

const fail = code => Object.assign(new Error(code), { code });
const label = value => String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
const ungrouped = 'desktop:ungrouped';

export async function readDesktopCatalog(client) {
  const [p, t] = await Promise.all([client.call('list_projects', {}), client.call('list_threads', { limit: 50 })]);
  if (!Array.isArray(p.projects) || !Array.isArray(t.threads) || !Array.isArray(t.pinnedThreads)) throw fail('DESKTOP_RESULT_INVALID');
  const projects = p.projects.filter(p => p.projectKind === 'local' && p.hostId === 'local' && typeof p.projectId === 'string')
    .map(p => ({ id: p.projectId, name: label(p.label || '未命名项目'), hostId: 'local' }));
  const projectIds = new Set(projects.map(p => p.id)), seen = new Set();
  const threads = [];
  for (const t0 of [...t.pinnedThreads, ...t.threads]) {
    if (t0.kind !== 'codex' || t0.hostId !== 'local' || typeof t0.id !== 'string'
        || t0.id === client.callerThreadId || seen.has(t0.id) || (t0.projectId != null && !projectIds.has(t0.projectId))) continue;
    seen.add(t0.id);
    threads.push({ id: t0.id, projectId: t0.projectId ?? ungrouped, hostId: 'local',
      name: label(t0.title || `未命名对话 ${t0.id.slice(-6)}`), status: t0.status });
  }
  projects.push({ id: ungrouped, name: '未分组对话', hostId: 'local' });
  return { projects, threads };
}

export function createDesktopNavigation(client, { state, createGateway = createDesktopGateway, now = Date.now }) {
  let selected = state.data.selection ?? {}, listing = null, busy = false;
  let listVersion = 0;
  const invalidateListing = () => { listing = null; listVersion++; };
  const cache = new Map();
  const control = (id, text) => ({ requestId: id, status: 'control', text });
  const uncertain = () => state.data.requests.some(r => r.status === 'unknown');
  const saveSelection = value => {
    const previous = state.data.selection;
    state.data.selection = value;
    try { state.save(); } catch (error) { state.data.selection = previous; throw error; }
    selected = value; invalidateListing();
    client.authorizedThreadId = value.threadId;
  };
  const render = () => {
    const page = listing.items.slice(listing.page * 5, listing.page * 5 + 5);
    if (!page.length) return '当前项目没有可列出的 Agent。接口范围为最近 50 条和置顶对话。';
    return `${listing.type === 'projects' ? '项目' : 'Agent'}列表：\n`
      + page.map((t, i) => `${i + 1}.${t.name}${t.status === 'active' || t.status === 'running' ? '（执行中）' : ''}`).join('\n')
      + '\n说选择 1 等当前页编号。' + (listing.items.length > 5 ? '可说下一页或上一页。' : '')
      + (listing.type === 'threads' ? '本轮范围为最近 50 条和置顶对话。' : '');
  };
  const setList = (type, items) => {
    listing = { type, items, page: 0, projectId: selected.projectId, expiresAt: now() + 120000 };
    return render();
  };
  async function navigate(c, assertCurrent) {
    assertCurrent?.();
    if (['projects', 'threads'].includes(c.type)) invalidateListing();
    const version = listVersion;
    if (c.type === 'create') return '语音新建目前只支持Paseo模式，请先切换连接模式。';
    if (c.type === 'recent') return 'Codex暂不支持按最后发言时间列出最近对话，可说列出Agent。';
    if (c.type === 'help') return '沿用当前项目、列出项目、当前 Agent、列出 Agent、选择 1、下一页、上一页。这里的 Agent 是 Codex 桌面对话。项目切换后需重新选择 Agent。';
    const catalog = await readDesktopCatalog(client);
    assertCurrent?.();
    if (version !== listVersion) throw fail('NAVIGATION_SESSION_STALE');
    const project = catalog.projects.find(p => p.id === selected.projectId);
    const threads = catalog.threads.filter(t => t.projectId === selected.projectId);
    if (c.type === 'projects') return setList('projects', catalog.projects);
    if (c.type === 'project') return project ? `当前项目：${project.name}。` : '当前项目不可用，请说列出项目重新选择。';
    if (c.type === 'thread') {
      if (!selected.threadId) return '请先选择 Agent，可说列出 Agent。';
      const thread = project && threads.find(t => t.id === selected.threadId);
      return thread ? `项目：${project.name}。当前 Agent：${thread.name}。` : '当前项目或 Agent 已变化，请重新列出并选择。';
    }
    if (c.type === 'threads') return project ? setList('threads', threads) : '请先选择项目，可说列出项目。';
    if (!listing || listing.expiresAt < now() || (listing.type === 'threads' && listing.projectId !== selected.projectId)) {
      listing = null; return '请先列出项目或列出 Agent，再说当前页编号。';
    }
    if (c.type === 'page') {
      listing.page = Math.max(0, Math.min(Math.max(0, Math.ceil(listing.items.length / 5) - 1), listing.page + c.delta));
      return render();
    }
    const index = selectionIndex(c.value), chosen = index >= 0 ? listing.items[listing.page * 5 + index] : null;
    if (!chosen) return '当前页没有这个编号，请按显示编号选择。';
    const fresh = (listing.type === 'projects' ? catalog.projects : threads).find(t => t.id === chosen.id);
    if (!fresh || (listing.type === 'threads' && !project)) { listing = null; return '名单或归属已变化，请重新列出后选择。'; }
    if (listing.type === 'projects') {
      saveSelection({ projectId: fresh.id });
      return `已选择项目：${fresh.name}。请先选择 Agent，可说列出 Agent。`;
    }
    saveSelection({ projectId: fresh.projectId, threadId: fresh.id });
    return `已选择 Agent：${fresh.name}。项目：${project.name}。后续确认发送会进入这条桌面对话。`;
  }
  return {
    invalidateListing,
    async submit(input = {}) {
      const { requestId, text } = input;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
          || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT');
      const hash = createHash('sha256').update(text.trim()).digest('hex');
      const previous = state.data.requests.find(r => r.id === requestId);
      if (previous) {
        if (previous.hash !== hash) throw fail('REQUEST_CONFLICT');
        return cache.get(requestId) ?? (previous.kind === 'control' ? control(requestId, '此口令已处理，请重新说出口令。') : { requestId, status: 'unknown', text: null });
      }
      const c = parseCodexCommand(text);
      input.assertCurrent?.();
      if (busy) return control(requestId, '已有请求执行中，请等待完成后再切换或发送。');
      if (uncertain() && c?.type === 'select') return control(requestId, '上一任务结果不明，请先在电脑核对，暂时不能切换会话。');
      if (uncertain() && !c) throw fail('OUTCOME_UNKNOWN');
      if (state.data.requests.length >= 256) throw fail('EXPERIMENT_FULL');
      busy = true;
      const operation = Promise.resolve().then(async () => {
        input.assertCurrent?.();
        if (c) return control(requestId, await navigate(c, input.assertCurrent));
        if (!selected.projectId) return control(requestId, '请先选择项目，可说列出项目。');
        if (!selected.threadId) return control(requestId, '请先选择 Agent，可说列出 Agent。');
        const catalog = await readDesktopCatalog(client);
        input.assertCurrent?.();
        const project = catalog.projects.find(p => p.id === selected.projectId);
        const current = project && catalog.threads.find(t => t.id === selected.threadId && t.projectId === selected.projectId);
        if (!current) return control(requestId, '当前项目或 Agent 已变化、失效或不在本轮名单内，请重新列出并选择。');
        if (current.status === 'active' || current.status === 'running') return control(requestId, '当前 Agent 正在执行，请等待完成。');
        client.authorizedThreadId = current.id;
        // Requests share one durable journal across all chosen threads.
        const childState = { data: { version: 1, threadId: current.id, requests: state.data.requests }, save: () => state.save() };
        const gateway = createGateway(client, { state: childState, target: { threadId: current.id, hostId: current.hostId, title: current.name } });
        return gateway.submit(input);
      }).catch(error => {
        if (state.data.requests.some(r => r.id === requestId && r.status === 'unknown')) return { requestId, status: 'unknown', text: null };
        return control(requestId, error.code === 'CODEX_BUSY' ? '当前 Agent 正在执行，请等待完成。' : '未能核对桌面项目或对话，本次没有发送。请重新列出后选择。');
      }).then(result => {
        if (result.status === 'control' && !state.data.requests.some(r => r.id === requestId)) {
          state.data.requests.push({ id: requestId, hash, kind: 'control', status: 'control' });
          state.save();
        }
        return result;
      }).finally(() => { busy = false; });
      cache.set(requestId, operation);
      return operation;
    },
  };
}
