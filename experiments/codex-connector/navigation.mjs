import { createHash, randomUUID } from 'node:crypto';
import { parseCodexCommand, selectionIndex } from '../codex-direct/navigation.mjs';
import { validId } from './journal.mjs';
import { readCatalog, projectForThread } from './catalog.mjs';
import { createQueueGateway } from './gateway.mjs';
import { readRecentConversations } from './recent.mjs';
import { createConnectorShortcuts, shortcutThreadAvailable } from './shortcuts.mjs';
import { createDesktopWake } from './wake.mjs';
import { assistantHelp } from '../../bridge/assistant-messages.mjs';

const fail = code => Object.assign(new Error(code), { code });
const hash = text => createHash('sha256').update(text.trim()).digest('hex');
const commandFor = text => {
  const raw = text.normalize('NFKC').trim().replace(/^(?:请(?:帮我)?|帮我)/u, '').replace(/[，。！？；,.;!?]+$/u, '');
  const create = raw.match(/^新建\s*对话[\s，,:：]*(.*)$/u);
  if (create) return { type: 'create', title: create[1].trim() };
  const value = text.normalize('NFKC').replace(/\s+/gu, '').replace(/[，。！？；,.;!?]+$/u, '').replace(/^(?:请(?:帮我)?|帮我)/u, '');
  return /^(?:查找|查询)对话/u.test(value)
    ? { type: 'search', query: value.slice(4).replace(/^[，,:：]+/u, '') } : parseCodexCommand(text);
};

export function createQueueNavigation(client, { journal, now = Date.now, gatewayOptions = {}, search, serverId, creation, wake = createDesktopWake() } = {}) {
  let selected = journal.getSelection() ?? {}, listing, revision = 0, busy = false, activeCatalog;
  const searchScope = 'codex-search:' + randomUUID();
  const gateways = new Map();
  const shortcuts = createConnectorShortcuts(client, { serverId });
  const control = (requestId, text) => ({ requestId, status: 'control', text });
  const invalidateListing = () => { listing = undefined; revision++; };
  const scope = threadId => ({ threadId,
    get(id) { const r = journal.get(id); if (r && r.targetThreadId !== threadId) throw fail('REQUEST_CONFLICT'); return r; },
    put(id, r) { journal.put(id, { ...r, kind: 'task', targetThreadId: threadId }); },
    pending: () => journal.pending().filter(([, r]) => r.targetThreadId === threadId),
    unresolved: () => journal.pending().some(([, r]) => r.targetThreadId === threadId),
  });
  function gateway(threadId) {
    if (!gateways.has(threadId)) {
      const bound = client.bindThread(threadId);
      gateways.set(threadId, createQueueGateway(bound,
      { ...gatewayOptions, journal: scope(threadId), validateSnapshot: snapshot => selected.threadId === threadId
        && projectForThread(snapshot, activeCatalog) === selected.projectId,
      async wakeQueued(record, assertCurrent) {
        assertCurrent?.();
        if (selected.threadId !== threadId || !validId(record?.queueId) || !validId(record?.clientId)) return;
        const snapshot = await bound.snapshot();
        assertCurrent?.();
        if (snapshot.status?.type !== 'notLoaded' || projectForThread(snapshot, activeCatalog) !== selected.projectId) return;
        const queued = await bound.queued();
        assertCurrent?.();
        if (selected.threadId !== threadId || !queued.some(q => q.id === record.queueId && q.clientUserMessageId === record.clientId)) return;
        await wake.run(threadId);
      } }));
    }
    return gateways.get(threadId);
  }
  async function settle() {
    for (const [id, r] of journal.pending()) {
      if (!r.targetThreadId) throw fail('OUTCOME_UNKNOWN');
      await gateway(r.targetThreadId).reconcile(id);
    }
    if (journal.unresolved()) throw fail('OUTCOME_UNKNOWN');
  }
  function render() {
    const size = listing.type === 'search' ? 2 : 5;
    const page = listing.items.slice(listing.page * size, listing.page * size + size);
    const partial = listing.partial ? listing.type === 'search' ? '部分对话仅检索标题或正文读取不完整。'
      : '部分对话缺少可靠发言时间或未能读取，未列入。' : '';
    const semantic = listing.searchSnapshot?.semanticAvailable === false ? '语义排序暂不可用，本次按关键词检索。' : '';
    if (!page.length) return (listing.type === 'recent' ? '暂无可列出的最近对话。'
      : listing.type === 'search' ? '没有找到匹配的对话，请换个描述。' : '名单为空，请选择其他项目。') + partial + semantic;
    const title = listing.type === 'recent' ? '最近对话（按你最后发言）' : listing.type === 'search' ? '搜索结果'
      : listing.type === 'projects' ? '项目' : 'Agent';
    return `${title}列表：\n`
      + page.map((item, i) => `${i + 1}.${['recent', 'search'].includes(listing.type) ? item.projectName + '：' : ''}${item.name}${['active', 'running'].includes(item.status) ? '（执行中）' : ''}${item.bodyCoverage === 'title-only' ? '（仅标题）' : ''}`).join('\n')
      + '\n说选择 1 等当前页编号。' + (listing.items.length > size ? '可说下一页或上一页。' : '') + partial + semantic;
  }
  function setList(type, items, partial = false, searchSnapshot) {
    listing = { type, items, partial, searchSnapshot, page: 0, projectId: selected.projectId, expiresAt: now() + 120000 };
    return render();
  }
  function select(value) { journal.saveSelection(value); selected = value; invalidateListing(); }
  async function navigate(command, input, catalog, check) {
    const project = catalog.projects.find(p => p.id === selected.projectId);
    const threads = catalog.threads.filter(t => t.projectId === selected.projectId);
    if (command.type === 'shortcut') {
      const target = await shortcuts.verify(command.target, check); check();
      const latest = await readCatalog(client); check();
      const targetProject = latest.projects.find(p => p.id === target.workspaceId);
      const targetThread = latest.threads.find(t => t.id === target.agentId && t.projectId === target.workspaceId);
      if (!targetProject || (target.kind === 'agent' && !targetThread)) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
      await settle(); check();
      if (target.kind === 'agent') {
        const snapshot = await client.bindThread(target.agentId).snapshot(); check();
        if (!shortcutThreadAvailable(snapshot, target.agentId, latest, target.workspaceId)) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
        select({ projectId: target.workspaceId, threadId: target.agentId });
        return `已切换到 Agent：${target.agentName}。项目：${target.workspaceName}。`;
      }
      select({ projectId: target.workspaceId });
      return `已切换到项目：${target.workspaceName}。\n` + setList('threads', latest.threads.filter(t => t.projectId === target.workspaceId));
    }
    if (command.type === 'help') return assistantHelp({ search: Boolean(search), creation: creation?.supported() === true, shortcuts: shortcuts.supported() });
    if (command.type === 'create') {
      if (!creation?.supported()) return '当前 Codex 入口尚未开启语音新建对话，本次未创建。';
      if (!command.title || [...command.title].length > 40) return '请在新建对话后补充名称，最多 40 个字符。';
      if (!project) return '请先选择可用项目，再说新建对话和名称。';
      try { await settle(); } catch { return '上一任务仍在执行或结果不明，暂时不能新建对话。'; }
      check();
      try {
        const target = await creation.create({ requestId: input.requestId, title: command.title, projectId: project.id,
          assertCurrent: check, onUpdate: input.onUpdate }); check();
        const fresh = await readCatalog(client); check();
        const thread = fresh.threads.find(t => t.id === target.threadId && t.projectId === project.id);
        if (!thread) return '新对话已创建，但暂未能核对选择。请列出 Agent 核对，不要重复新建。';
        const snapshot = await client.bindThread(thread.id).snapshot(); check();
        if (!shortcutThreadAvailable(snapshot, thread.id, fresh, project.id)) return '新对话已创建，但归属暂未确认。请在电脑核对，不要重复新建。';
        select({ projectId: project.id, threadId: thread.id });
        return `新对话已创建并选中。项目：${project.name}。名称：${thread.name}。说完问题后，单独说确认发送。`;
      } catch (e) {
        if (/^NAVIGATION_/.test(e?.code ?? '')) throw e;
        return ({ CREATION_NAME: '名称无效，请补充不超过 40 个字符的名称。', CREATION_SCOPE: '这个项目没有唯一可用目录，请先在电脑核对项目配置。',
          CREATION_DUPLICATE: '当前项目已有同名对话，本次未创建。请列出 Agent 选择已有对话。',
          CREATION_REPLAY: '此创建请求已处理，没有重复创建。请列出 Agent 核对。' })[e?.code]
          ?? '创建或切换结果暂未确认，请在电脑核对，不要重复新建。';
      }
    }
    if (command.type === 'recent') {
      const result = await readRecentConversations(client, catalog, { assertCurrent: check });
      check();
      return setList('recent', result.items, result.partial);
    }
    if (command.type === 'search') {
      if (!command.query) return '请在查找对话后补充项目或主题。';
      if ([...command.query].length > 200) return '搜索描述太长，请缩短主题后重新查找。';
      if (!search) return '当前 Codex 入口尚未开启对话搜索，本次未发送给模型。';
      try { input.onUpdate?.({ type: 'state', state: 'searching' }); } catch { /* Display cannot change search routing. */ }
      const result = await search.search(command.query, { scopeKey: searchScope, assertCurrent: check }); check();
      if (result.reason === 'unknown-project') return '没识别出这个项目，请说列出项目核对名称。';
      if (result.reason === 'empty-query') return '请补充具体的查找主题。';
      const items = result.items.slice(0, 5).map(item => ({ id: item.agentId, name: item.name,
        projectId: item.workspaceId, projectName: item.workspaceName, status: item.status, bodyCoverage: item.bodyCoverage }));
      return setList('search', items, result.coverage !== 'complete', result);
    }
    if (command.type === 'projects') return setList('projects', catalog.projects);
    if (command.type === 'project') return project ? `当前项目：${project.name}。` : '当前项目不可用，请先选择项目，可说列出项目。';
    if (command.type === 'thread') {
      const thread = project && threads.find(t => t.id === selected.threadId);
      return thread ? `项目：${project.name}。当前 Agent：${thread.name}。` : '当前 Agent 不可用，请重新列出 Agent 并选择。';
    }
    if (command.type === 'threads') return project ? setList('threads', threads) : '请先选择项目，可说列出项目。';
    if (!listing || listing.expiresAt <= now() || (listing.type === 'threads' && listing.projectId !== selected.projectId)) {
      invalidateListing(); return '请先列出项目、列出 Agent 或最近对话，再按当前页编号选择。';
    }
    if (command.type === 'page') {
      const size = listing.type === 'search' ? 2 : 5;
      listing.page = Math.max(0, Math.min(Math.max(0, Math.ceil(listing.items.length / size) - 1), listing.page + command.delta));
      return render();
    }
    const size = listing.type === 'search' ? 2 : 5;
    const i = selectionIndex(command.value), old = i >= 0 && i < size ? listing.items[listing.page * size + i] : null;
    if (!old) return '当前页没有这个编号，请按显示的编号选择。';
    const crossProject = ['recent', 'search'].includes(listing.type);
    const fresh = (listing.type === 'projects' ? catalog.projects : crossProject ? catalog.threads : threads).find(x => x.id === old.id);
    if (!fresh || (crossProject && fresh.projectId !== old.projectId)) {
      invalidateListing(); return '名单或归属已变化，请重新列出后选择。';
    }
    try { await settle(); } catch { return '上一任务仍在执行或结果不明，请先在电脑核对，暂时不能切换。'; }
    check();
    if (listing.type === 'projects') {
      select({ projectId: fresh.id }); return `已选择项目：${fresh.name}。请先选择 Agent，可说列出 Agent。`;
    }
    if (listing.type === 'search') {
      let resolved;
      try { resolved = await search.resolve({ snapshot: listing.searchSnapshot, itemIndex: listing.page * size + i, scopeKey: searchScope }); }
      catch { check(); invalidateListing(); return '搜索名单已失效，请重新查找后选择。'; }
      check();
      if (resolved.agentId !== fresh.id || resolved.workspaceId !== fresh.projectId) {
        invalidateListing(); return '对话归属已变化，请重新查找后选择。';
      }
    }
    const targetProjectId = crossProject ? fresh.projectId : selected.projectId;
    const bound = client.bindThread(fresh.id), snapshot = await bound.snapshot(); check();
    if (snapshot.id !== fresh.id || projectForThread(snapshot, catalog) !== targetProjectId) {
      invalidateListing(); return '对话归属已变化，请重新列出并选择。';
    }
    const targetProject = catalog.projects.find(p => p.id === targetProjectId);
    select({ projectId: fresh.projectId, threadId: fresh.id });
    return `已选择 Agent：${fresh.name}。项目：${targetProject.name}。后续确认发送会进入这条原对话。`;
  }
  return {
    invalidateListing,
    shortcutsSupported: shortcuts.supported,
    async resolveShortcut(input, assertCurrent) {
      if (input?.useCurrent !== true) return shortcuts.resolve(input, assertCurrent);
      if (!['agent', 'workspace'].includes(input.kind) || Object.keys(input).some(k => !['kind', 'useCurrent'].includes(k))) throw fail('INVALID_INPUT');
      const version = revision, target = { ...selected };
      const check = () => { assertCurrent?.(); if (version !== revision) throw fail('NAVIGATION_SESSION_STALE'); };
      check();
      if (!target.projectId || (input.kind === 'agent' && !target.threadId)) throw fail('SHORTCUT_TARGET_UNAVAILABLE');
      const resolved = await shortcuts.verify({ kind: input.kind, serverId, workspaceId: target.projectId,
        ...(input.kind === 'agent' ? { agentId: target.threadId } : {}) }, check); check(); return resolved;
    },
    creationSupported: () => creation?.supported() === true,
    async submit(input = {}) {
      const { requestId, text } = input;
      if (!validId(requestId) || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT');
      const isShortcut = Object.hasOwn(input, 'shortcut');
      const fingerprint = hash(isShortcut ? JSON.stringify([text, input.shortcut]) : text), previous = journal.get(requestId),
        command = isShortcut ? { type: 'shortcut', target: input.shortcut } : commandFor(text);
      if (previous && previous.hash !== fingerprint) throw fail('REQUEST_CONFLICT');
      if (busy) return control(requestId, '已有请求执行中，请等待完成后再选择或发送。');
      busy = true;
      try {
        input.assertCurrent?.();
        if (previous?.kind === 'control') return control(requestId, '此口令已处理，请重新说出口令。');
        if (command && ['projects', 'threads', 'recent', 'search', 'shortcut', 'create'].includes(command.type)) listing = undefined;
        const version = revision;
        const check = () => { input.assertCurrent?.(); if (revision !== version) throw fail('NAVIGATION_SESSION_STALE'); };
        const catalog = await readCatalog(client); check(); activeCatalog = catalog;
        if (previous) {
          if (!previous.targetThreadId) throw fail('OUTCOME_UNKNOWN');
          return await gateway(previous.targetThreadId).submit(input);
        }
        if (command) {
          // Persist the command before its effects, so an HTTP replay cannot reselect.
          journal.put(requestId, { hash: fingerprint, clientId: randomUUID(), status: 'idle', kind: 'control' });
          if (!isShortcut) return control(requestId, await navigate(command, input, catalog, check));
          try {
            return { ...control(requestId, await navigate(command, input, catalog, check)), shortcutApplied: true };
          } catch (error) {
            if (/^NAVIGATION_/.test(error?.code ?? '')) throw error;
            return control(requestId, ['INVALID_INPUT', 'SHORTCUT_HOST_CHANGED', 'SHORTCUT_UNSUPPORTED', 'SHORTCUT_TARGET_UNAVAILABLE'].includes(error?.code)
              ? error.message || '快捷目标已不可用，请重新绑定。' : '快捷切换未确认，请检查电脑状态并重新核对当前 Agent。');
          }
        }
        if (!selected.projectId) return control(requestId, '请先选择项目，可说列出项目。');
        if (!selected.threadId) return control(requestId, '请先选择 Agent，可说列出 Agent。');
        const target = catalog.threads.find(t => t.id === selected.threadId && t.projectId === selected.projectId);
        if (!target) return control(requestId, '当前项目或对话已变化，请重新列出并选择。');
        await settle(); check();
        const bound = client.bindThread(target.id), snapshot = await bound.snapshot(); check();
        if (snapshot.id !== target.id || projectForThread(snapshot, catalog) !== selected.projectId) {
          return control(requestId, '对话归属已变化，请重新列出并选择。');
        }
        try { return await gateway(target.id).submit({ ...input, assertCurrent: check }); }
        catch (e) {
          if (e.code !== 'INVALID_TARGET') throw e;
          invalidateListing(); return control(requestId, '对话归属已变化，请重新列出并选择。');
        }
      } finally { busy = false; }
    },
  };
}
