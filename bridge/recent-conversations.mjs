const SNAPSHOT_LIFETIME_MS = 120000;
const snapshots = new WeakSet();

class RecentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) { return new RecentError(code, message); }
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function label(value, fallback) {
  return text(value) ? value.replace(/\s+/gu, ' ').trim() : fallback;
}

// Require an explicit time zone and reject dates Date.parse would silently roll forward.
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = match.slice(1).map(part => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

async function guarded(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof RecentError) throw error;
    // Upstream errors may contain addresses, credentials or conversation data.
    throw fail('RECENT_READ_FAILED', '最近对话读取失败，请稍后重新列出。');
  }
}

async function collectPages(fetchPage) {
  const entries = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page?.entries) || !page.pageInfo || typeof page.pageInfo !== 'object') {
      throw fail('INVALID_PAGE', '最近对话列表格式无效，请重新列出。');
    }
    entries.push(...page.entries);
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor !== undefined) {
      if (!text(cursor) || cursors.has(cursor)) {
        throw fail('INVALID_PAGE', '最近对话分页位置无效，请重新列出。');
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return entries;
}

async function visibleWorkspaces(client) {
  const entries = await collectPages(cursor => client.workspaces.list({
    page: { limit: 50, ...(cursor ? { cursor } : {}) },
  }));
  const workspaces = new Map();
  for (const workspace of entries) {
    if (!workspace || workspace.archivedAt) continue;
    if (!text(workspace.id) || !text(workspace.project?.projectKey)) {
      throw fail('MISSING_SCOPE', '工作区缺少项目标识，已停止读取最近对话。');
    }
    const previous = workspaces.get(workspace.id);
    if (previous && previous.project.projectKey !== workspace.project.projectKey) {
      throw fail('RECENT_IDENTITY_CONFLICT', '项目归属发生变化，请重新列出最近对话。');
    }
    workspaces.set(workspace.id, workspace);
  }
  return workspaces;
}

function candidate(agent, workspace) {
  return Object.freeze({
    backend: 'paseo', workspaceId: workspace.id, agentId: agent.id,
    projectKey: workspace.project.projectKey,
    workspaceName: label(workspace.title ?? workspace.name, '未命名项目'),
    name: label(agent.title, '未命名 Agent'),
    status: label(agent.status, 'unknown'),
    lastUserMessageAt: timestamp(agent.lastUserMessageAt),
    updatedAt: timestamp(agent.updatedAt),
  });
}

function makeSnapshot(items, { scopeKey, now, omittedWithoutUserTime }) {
  const snapshot = Object.freeze({
    backend: 'paseo', scopeKey, sortBasis: 'lastUserMessageAt',
    source: 'paseo.agent.lastUserMessageAt',
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SNAPSHOT_LIFETIME_MS).toISOString(),
    coverage: omittedWithoutUserTime ? 'partial' : 'complete',
    omittedWithoutUserTime, items: Object.freeze(items),
  });
  snapshots.add(snapshot);
  return snapshot;
}

/**
 * Read metadata across visible Paseo projects, then sort by last USER message.
 * scopeKey must identify the caller's current server/connection scope.
 * The immutable snapshot is ephemeral; never persist it as a second selection store.
 * coverage describes this traversal, not an atomic server-side snapshot.
 */
export async function readRecentPaseoConversations(client, {
  scopeKey, now = Date.now(), excludeAgentIds = [],
} = {}) {
  if (!text(scopeKey) || !Number.isFinite(now) || !Number.isFinite(new Date(now + SNAPSHOT_LIFETIME_MS).getTime())
    || !Array.isArray(excludeAgentIds) || excludeAgentIds.some(id => !text(id))) {
    throw fail('INVALID_INPUT', '最近对话缺少有效的连接作用域或读取参数。');
  }
  return guarded(async () => {
    const workspaces = await visibleWorkspaces(client);
    const byId = new Map();
    if (workspaces.size) {
      const projectKeys = [...new Set([...workspaces.values()].map(w => w.project.projectKey))];
      const entries = await collectPages(cursor => client.agents.list({
        filter: { projectKeys, includeArchived: false },
        page: { limit: 50, ...(cursor ? { cursor } : {}) },
      }));
      const excluded = new Set(excludeAgentIds);
      for (const entry of entries) {
        const agent = entry?.agent;
        if (!agent || agent.archivedAt || agent.internal || excluded.has(agent.id)) continue;
        const workspace = workspaces.get(agent.workspaceId);
        if (!workspace) continue;
        if (!text(agent.id)) throw fail('RECENT_IDENTITY_CONFLICT', '最近对话缺少有效身份，请重新列出。');
        const next = candidate(agent, workspace);
        const previous = byId.get(agent.id);
        if (previous && previous.workspaceId !== next.workspaceId) {
          throw fail('RECENT_IDENTITY_CONFLICT', '对话归属发生变化，请重新列出最近对话。');
        }
        if (!previous || Date.parse(next.lastUserMessageAt ?? '') > Date.parse(previous.lastUserMessageAt ?? '')
          || (!previous.lastUserMessageAt && next.lastUserMessageAt)) byId.set(agent.id, next);
      }
    }
    const all = [...byId.values()];
    const items = all.filter(item => item.lastUserMessageAt);
    items.sort((a, b) => Date.parse(b.lastUserMessageAt) - Date.parse(a.lastUserMessageAt)
      || (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0)
      || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
    return makeSnapshot(items, { scopeKey, now, omittedWithoutUserTime: all.length - items.length });
  });
}

/**
 * Resolve a zero-based index from a module-issued, unexpired snapshot.
 * This module does NOT track which snapshot navigation currently displays.
 * Navigation maps page/number and must check its current snapshot/list version,
 * backend and scope before calling AND after awaiting, before its atomic save.
 * Publishing a new list or changing selection/mode must invalidate the old version;
 * concurrent list requests must not let an older response replace the newer list.
 * Navigation also retains its existing busy/unknown/dedup guards and save logic.
 * This function never selects, sends, or reads conversation bodies.
 */
export async function resolveRecentPaseoConversation(client, {
  snapshot, backend, scopeKey, itemIndex, now,
} = {}) {
  const stale = () => fail('RECENT_STALE', '最近对话名单已失效，请重新列出后选择。');
  const valid = () => {
    const currentTime = now ?? Date.now();
    return snapshots.has(snapshot) && backend === 'paseo' && scopeKey === snapshot.scopeKey
      && Number.isFinite(currentTime) && currentTime >= Date.parse(snapshot.fetchedAt)
      && currentTime < Date.parse(snapshot.expiresAt)
      && Number.isInteger(itemIndex) && itemIndex >= 0 && itemIndex < snapshot.items.length;
  };
  if (!valid()) throw stale();
  return guarded(async () => {
    const chosen = snapshot.items[itemIndex];
    const workspaces = await visibleWorkspaces(client);
    const workspace = workspaces.get(chosen.workspaceId);
    if (!workspace || workspace.project.projectKey !== chosen.projectKey) throw stale();
    const refreshed = await client.agents.ref(chosen.agentId).refresh();
    const agent = refreshed?.agent;
    if (!valid() || !agent || agent.id !== chosen.agentId || agent.workspaceId !== chosen.workspaceId
      || agent.archivedAt || agent.internal) throw stale();
    return candidate(agent, workspace);
  });
}
