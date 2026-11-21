import { createHash, randomUUID } from 'node:crypto';
import { readVoiceWorkspaces, readVoiceAgents } from './reader.mjs';
import { readRecentPaseoConversations, resolveRecentPaseoConversation } from './recent-conversations.mjs';
import { createTurnGateway } from './turns.mjs';
import { creationMessages } from './agent-creation.mjs';
import { createShortcutTargets } from './shortcuts.mjs';
import { assistantHelp } from './assistant-messages.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const label = text => String(text).replace(/[\r\n]+/g, ' ').slice(0, 60);
const pageSize = 5;
const requestHash = input => createHash('sha256').update(Object.hasOwn(input, 'shortcut')
  ? JSON.stringify({ text: input.text, shortcut: input.shortcut }) : input.text).digest('hex');

export function parseVoiceCommand(text) {
  if (typeof text !== 'string') return null;
  const input = text.normalize('NFKC').replace(/\s+/gu, '').replace(/[，。！？；,.;!?]+$/u, '').replace(/^(?:请(?:帮我)?|帮我)/u, '');
  if (input.startsWith('新建对话')) return { type: 'create', title: text.normalize('NFKC').trim()
    .replace(/^(?:请\s*(?:帮\s*我\s*)?|帮\s*我\s*)?新\s*建\s*对\s*话\s*[，,:：]?\s*/u, '')
    .replace(/[，。！？；,.;!?]+$/u, '').trim() };
  if (/^(?:查找|查询)对话/u.test(input)) return { type: 'search', query: input.slice(4).replace(/^[，,:：]+/u, '') };
  if (/^(?:进入(?:Paseo|对话)|当前(?:Agent|会话))$/iu.test(input)) return { type: 'current' };
  if (input === '当前项目') return { type: 'current-workspace' };
  if (input === '口令帮助') return { type: 'help' };
  if (/^(?:列出项目|项目列表)$/u.test(input)) return { type: 'workspaces' };
  if (/^(?:列出Agent|Agent列表)$/iu.test(input)) return { type: 'agents' };
  if (/^(?:列出)?最近对话$/u.test(input)) return { type: 'recent' };
  if (input === '下一页' || input === '上一页') return { type: 'page', delta: input === '下一页' ? 1 : -1 };
  const selection = input.match(/^选择(第?(?:[0-9]+|[零〇一二两三四五六七八九十百]+)(?:个|项|号)?)$/u);
  return selection ? { type: 'select', value: selection[1] } : null;
}

function spokenIndex(text) {
  const value = text.replace(/^第/, '').replace(/(?:个|项|号)$/, '');
  if (/^[1-5]$/.test(value)) return Number(value) - 1;
  return ['一', '二', '三', '四', '五'].indexOf(value === '两' ? '二' : value);
}

/** One authenticated phone, explicit selection, and no model calls for navigation. */
export function createVoiceGateway(client, { agentId, workspaceId, stateStore, allowUnselected = false, search, creation }) {
  if ((!agentId || !workspaceId) && !(allowUnselected && !agentId && !workspaceId)) throw fail('INVALID_INPUT', '必须指定初始 Agent 和项目。');
  let selected = stateStore?.getSelection() ?? (agentId ? { agentId, workspaceId } : {}), listing = null, busy = false, controlling = false;
  const scopeKey = `paseo-gateway:${randomUUID()}`;
  const shortcuts = createShortcutTargets(client);
  let listVersion = 0;
  // Lifecycle callers must use this on a connection/mode change. No task or journal is cleared.
  const invalidateListing = () => { listing = null; listVersion++; };
  const checkVersion = (version, expected) => {
    if (listVersion !== version || (expected && listing !== expected)) throw fail('LIST_STALE', '名单已失效，请重新列出后选择。');
  };
  const select = value => { stateStore?.saveSelection(value); selected = value; invalidateListing(); };
  const requests = new Map(), gateways = new Map();
  const control = (requestId, text) => ({ requestId, agentId: selected.agentId ?? null, status: 'control', text });
  const render = () => {
    if (listing?.type === 'search') {
      const { snapshot } = listing;
      const warning = snapshot.coverage === 'partial' ? '，部分正文未查' : '';
      if (!listing.items.length) return `没找到匹配对话${warning}。请换个主题或加上项目名再查找。`;
      const short = text => { let width = 0, result = ''; for (const ch of text) {
        width += ch.codePointAt(0) >= 32 && ch.codePointAt(0) <= 126 ? 1 : 2;
        if (width > 46) return result + '…'; result += ch;
      } return result; };
      const page = listing.items.slice(listing.page * 2, listing.page * 2 + 2);
      return `${snapshot.semanticAvailable === false ? '关键词候选' : '搜索候选'}${listing.page + 1}/${Math.ceil(listing.items.length / 2)}${warning}\n`
        + page.map((item, i) => short(`${i + 1}.${label(item.workspaceName)}：${label(item.name)}`)).join('\n')
        + '\n说选择1或2；下一页看其他候选';
    }
    const partial = listing?.snapshot?.coverage === 'partial' ? '部分对话缺少最后发言时间，未列入。' : '';
    if (listing?.type === 'recent' && !listing.items.length) return `暂无可列出的最近对话。${partial}可说列出项目或列出 Agent。`;
    if (!listing?.items.length) return '名单为空，请选择其他项目。';
    const title = listing.type === 'recent' ? '最近对话（按你最后发言）' : listing.type === 'workspace' ? '项目' : 'Agent';
    const page = listing.items.slice(listing.page * pageSize, (listing.page + 1) * pageSize);
    return `${title}列表：\n${page.map((item, index) => `${index + 1}.${listing.type === 'recent' ? `${label(item.workspaceName)}：` : ''}${label(item.name)}${item.status === 'running' ? '（执行中）' : ''}`).join('\n')}\n`
      + `说“选择 1”等当前页编号。${listing.items.length > pageSize ? '可说下一页或上一页。' : ''}${partial}`;
  };
  const setList = (type, items, version, snapshot, assertCurrent) => {
    assertCurrent?.();
    checkVersion(version);
    listing = { type, items, page: 0, workspaceId: selected.workspaceId, version, ...(snapshot ? { snapshot } : {}) };
    return render();
  };
  async function workspace() {
    const all = await readVoiceWorkspaces(client);
    return all.find(item => item.id === selected.workspaceId);
  }
  async function navigate(command, assertCurrent, onUpdate, activeRequestId) {
    assertCurrent?.();
    if (['workspaces', 'agents', 'recent', 'search', 'create'].includes(command.type)) invalidateListing();
    const version = listVersion;
    if (command.type === 'shortcut') {
      const guard = () => { assertCurrent?.(); checkVersion(version); };
      const target = await shortcuts.verify(command.target, guard);
      if (target.kind === 'agent') {
        guard(); select({ workspaceId: target.workspaceId, agentId: target.agentId });
        return `已切换到 Agent：${target.agentName}。\n工作区：${target.workspaceName}。`;
      }
      const current = (await readVoiceWorkspaces(client)).find(w => w.id === target.workspaceId);
      guard();
      if (!current) throw fail('SHORTCUT_TARGET_UNAVAILABLE', '快捷目标已不可用，本次未切换。请在手机重新绑定。');
      const items = await readVoiceAgents(client, current);
      await shortcuts.verify(target, guard);
      guard(); select({ workspaceId: target.workspaceId });
      return `已切换到工作区：${target.workspaceName}。\n` + setList('agent', items, listVersion, undefined, assertCurrent);
    }
    if (command.type === 'help') return assistantHelp({ search: Boolean(search), creation: creation?.supported() === true, shortcuts: shortcuts.supported() });
    if (command.type === 'create') {
      if (!creation?.supported()) return creationMessages.CREATION_UNSUPPORTED;
      if (!command.title) return creationMessages.CREATION_NAME;
      const target = await creation.create({ requestId: activeRequestId, title: command.title,
        workspaceId: selected.workspaceId, assertCurrent: () => { assertCurrent?.(); checkVersion(version); }, onUpdate });
      assertCurrent?.(); checkVersion(version);
      try { select({ workspaceId: target.workspaceId, agentId: target.agentId }); }
      catch { return creationMessages.CREATION_SELECTION; }
      return `新对话已创建并选中。\n项目：${label(target.workspaceName)}\n名称：${label(target.name)}\n说完问题后，单独说确认发送。`;
    }
    if (command.type === 'search') {
      if (!command.query) return '请说查找对话，再加上项目名或大致主题。';
      if ([...command.query].length > 200) return '搜索描述太长，请用一句话说查找对话和主题。';
      if (!search) return '当前接入服务尚未开启对话搜索。';
      try { onUpdate?.({ type: 'state', state: 'searching' }); } catch { /* A display failure must not change search dispatch. */ }
      const snapshot = await search.search(command.query, { scopeKey, assertCurrent: () => { assertCurrent?.(); checkVersion(version); } });
      if (snapshot.reason === 'unknown-project') return '没识别出这个项目，请说列出项目核对名称，再查找对话。';
      if (snapshot.reason === 'empty-query') return '请在查找对话后补充具体主题。';
      return setList('search', snapshot.items, version, snapshot, assertCurrent);
    }
    if (command.type === 'recent') {
      const snapshot = await readRecentPaseoConversations(client, { scopeKey });
      return setList('recent', snapshot.items, version, snapshot, assertCurrent);
    }
    if (listing?.type === 'recent' && ['page', 'select'].includes(command.type)
      && Date.now() >= Date.parse(listing.snapshot.expiresAt)) {
      invalidateListing();
      return '最近对话名单已失效，请重新列出最近对话后选择。';
    }
    if (command.type === 'page') {
      if (!listing) return '请先说列出项目，或列出 Agent。';
      if (listing.type === 'search' && Date.now() >= listing.snapshot.expiresAt) { invalidateListing(); return '搜索名单已过期，请重新查找对话。'; }
      const size = listing.type === 'search' ? 2 : pageSize;
      listing.page = Math.max(0, Math.min(Math.max(0, Math.ceil(listing.items.length / size) - 1), listing.page + command.delta));
      return render();
    }
    if (command.type === 'workspaces') return setList('workspace', await readVoiceWorkspaces(client), version, undefined, assertCurrent);
    if (command.type === 'current' || command.type === 'current-workspace') {
      const current = await workspace();
      if (!current) return '当前项目已不可用，请说列出项目重新选择。';
      if (command.type === 'current-workspace') return `当前项目：${label(current.name)}。`;
      if (!selected.agentId) return `当前项目：${label(current.name)}。请先选择 Agent，可说列出 Agent。`;
      const { agent } = await client.agents.ref(selected.agentId).refresh();
      assertCurrent?.();
      checkVersion(version);
      if (!agent || agent.id !== selected.agentId || agent.workspaceId !== selected.workspaceId || agent.archivedAt) {
        select({ workspaceId: selected.workspaceId });
        return '当前 Agent 已变化，请先选择 Agent，可说列出 Agent。';
      }
      return `项目：${label(current.name)}。当前 Agent：${label(agent.title ?? '未命名 Agent')}。\n可说列出项目、列出 Agent，再说选择 1 等编号；普通问题说完后单独说确认发送。`;
    }
    if (command.type === 'agents') {
      const current = await workspace();
      checkVersion(version);
      if (!current) return '请先选择项目，可说列出项目。';
      return setList('agent', await readVoiceAgents(client, current), version, undefined, assertCurrent);
    }
    if (!listing || (listing.type === 'agent' && listing.workspaceId !== selected.workspaceId)) {
      invalidateListing();
      return '请先说列出项目，或列出 Agent，再说选择 1 等编号。';
    }
    const type = listing.type;
    const title = type === 'workspace' ? '项目' : 'Agent';
    const index = spokenIndex(command.value);
    const size = type === 'search' ? 2 : pageSize;
    const choice = index >= 0 && index < size ? listing.items[listing.page * size + index] : null;
    if (!choice) return '当前页没有这个编号，请按显示的编号选择，或说下一页。';
    const currentListing = listing;
    if (type === 'search') {
      let target;
      try { target = await search.resolve({ snapshot: currentListing.snapshot, itemIndex: currentListing.page * 2 + index, scopeKey }); }
      catch (error) { if (listing === currentListing) invalidateListing(); throw error; }
      checkVersion(version, currentListing); assertCurrent?.();
      select({ workspaceId: target.workspaceId, agentId: target.agentId });
      return `已选择 Agent：${label(target.name)}。项目：${label(target.workspaceName)}。${target.status === 'running' ? '该 Agent 执行中，完成后再提问。' : '说完问题后，单独说确认发送。'}`;
    }
    if (type === 'recent') {
      let target;
      try {
        target = await resolveRecentPaseoConversation(client, { snapshot: currentListing.snapshot,
          backend: 'paseo', scopeKey, itemIndex: currentListing.page * pageSize + index });
      } catch (error) {
        if (listing === currentListing) invalidateListing();
        throw error;
      }
      checkVersion(version, currentListing);
      assertCurrent?.();
      select({ workspaceId: target.workspaceId, agentId: target.agentId });
      return `已选择 Agent：${label(target.name)}。项目：${label(target.workspaceName)}。${target.status === 'running' ? '该 Agent 执行中，完成后再提问。' : '说完问题后，单独说确认发送。'}`;
    }
    const current = type === 'agent' ? await workspace() : null;
    if (type === 'agent' && !current) return '请先选择项目，可说列出项目。';
    const items = type === 'workspace' ? await readVoiceWorkspaces(client) : await readVoiceAgents(client, current);
    checkVersion(version, currentListing);
    assertCurrent?.();
    if (!items.some(item => item.id === choice.id)) {
      invalidateListing();
      return `名单已变化，请重新列出${title}再选择。`;
    }
    if (type === 'workspace') {
      select({ workspaceId: choice.id });
      return `已选择项目：${label(choice.name)}。请先选择 Agent，可说列出 Agent。`;
    }
    const { agent } = await client.agents.ref(choice.id).refresh();
    checkVersion(version, currentListing);
    assertCurrent?.();
    if (!agent || agent.id !== choice.id || agent.workspaceId !== selected.workspaceId || agent.archivedAt) {
      invalidateListing();
      return 'Agent 已变化，请重新列出 Agent 再选择。';
    }
    select({ workspaceId: selected.workspaceId, agentId: choice.id });
    return `已选择 Agent：${label(agent.title ?? '未命名 Agent')}。项目：${label(current.name)}。${agent.status === 'running' ? '该 Agent 执行中，完成后再提问。' : '说完问题后，单独说确认发送。'}`;
  }
  async function dispatch(input) {
    input.assertCurrent?.();
    const command = Object.hasOwn(input, 'shortcut') ? { type: 'shortcut', target: input.shortcut } : parseVoiceCommand(input.text);
    const target = { ...selected };
    const task = !command && !busy && !controlling && target.agentId && target.workspaceId;
    // Reserve controls as well: an old number must never act on a new list after restart.
    stateStore?.reserveRequest(input.requestId, { hash: requestHash(input),
      kind: task ? 'task' : 'control', ...(task ? target : {}) });
    if (busy || controlling) return control(input.requestId, '已有任务执行中，请等完成后再选择或发送。');
    if (command) {
      controlling = true;
      try {
        const text = await navigate(command, input.assertCurrent, input.onUpdate, input.requestId);
        return { ...control(input.requestId, text), ...(command.type === 'shortcut' ? { shortcutApplied: true } : {}) };
      }
      catch (error) {
        if (command.type === 'shortcut') return control(input.requestId,
          ['SHORTCUT_HOST_CHANGED', 'SHORTCUT_UNSUPPORTED', 'SHORTCUT_TARGET_UNAVAILABLE', 'INVALID_INPUT'].includes(error?.code)
            ? error.message : error?.code === 'STATE_WRITE_FAILED' ? '快捷选择未能保存，本次未切换。请检查电脑存储。'
              : '快捷目标未能核对，本次未切换。请检查连接或在手机重新绑定。');
        if (command.type === 'create') return control(input.requestId,
          creationMessages[error?.code] ?? '会话已变化或创建结果未确认，请在 Paseo 核对；本次未切换，不要重复新建。');
        return control(input.requestId, ['LIST_STALE', 'RECENT_STALE', 'SEARCH_STALE'].includes(error?.code)
        || /^NAVIGATION_/.test(error?.code ?? '') ? '名单已失效，请重新列出后选择。' : '未能读取或核对名单，没有发送消息。请重新列出后再选择。'); }
      finally { controlling = false; }
    }
    if (!target.workspaceId) return control(input.requestId, '请先选择项目，可说列出项目。');
    if (!target.agentId) return control(input.requestId, '请先选择 Agent，可说列出 Agent。');
    const key = JSON.stringify([target.workspaceId, target.agentId]);
    if (!stateStore && !gateways.has(key)) gateways.set(key, createTurnGateway(client, target));
    busy = true;
    try {
      if (!await workspace()) return control(input.requestId, '当前项目已不可用，请重新选择项目，可说列出项目。');
      input.assertCurrent?.();
      // The durable outer journal owns daily-profile deduplication; do not grow per-agent caches forever.
      const gateway = stateStore ? createTurnGateway(client, target) : gateways.get(key);
      return await gateway.submit(input);
    }
    finally { busy = false; }
  }
  return {
    invalidateListing,
    shortcutsSupported: shortcuts.supported,
    resolveShortcut: shortcuts.resolve,
    creationSupported: () => Boolean(creation?.supported()),
    async submit(input = {}) {
      const { requestId, text } = input;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT', '请求编号或问题格式不正确。');
      const hash = requestHash(input);
      const previous = requests.get(requestId);
      if (previous) {
        if (previous.hash !== hash) throw fail('REQUEST_CONFLICT', '同一请求编号不能用于不同问题。');
        return previous.promise;
      }
      const recorded = stateStore?.findRequest(requestId);
      if (recorded) {
        if (recorded.hash !== hash) throw fail('REQUEST_CONFLICT', '同一请求编号不能用于不同问题。');
        return recorded.kind === 'control'
          ? { requestId, agentId: recorded.agentId ?? null, status: 'control', text: '此口令已处理，没有重新执行；请重新说出需要的口令。' }
          : { requestId, agentId: recorded.agentId, status: 'unknown', text: null };
      }
      if (requests.size >= 256) {
        const completed = stateStore && [...requests].find(([, item]) => !item.pending);
        if (!completed) throw fail('SESSION_FULL', '本轮请求已满，请先核对任务状态。');
        requests.delete(completed[0]);
      }
      const promise = Promise.resolve().then(() => dispatch(input));
      const entry = { hash, promise, pending: true };
      requests.set(requestId, entry);
      promise.then(() => { entry.pending = false; }, () => { entry.pending = false; });
      return promise;
    },
  };
}
