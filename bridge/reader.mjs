function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail('INVALID_INPUT', `${name} 不能为空。`);
  }
  return value.trim();
}

async function collectPages(fetchPage) {
  const entries = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page?.entries) || !page.pageInfo) {
      throw fail('INVALID_PAGE', 'Paseo 返回了无法识别的列表。');
    }
    entries.push(...page.entries);
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) {
      throw fail('INVALID_PAGE', 'Paseo 返回了无效或重复的分页位置。');
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return entries;
}

/** Voice navigation reads names and identities, never conversation bodies. */
export async function readVoiceWorkspaces(client) {
  const entries = await collectPages(cursor => client.workspaces.list({
    page: { limit: 50, ...(cursor ? { cursor } : {}) },
  }));
  return entries.filter(w => !w.archivedAt).map(w => ({
    id: w.id, name: w.title ?? w.name ?? '未命名项目', projectKey: w.project?.projectKey,
  }));
}

export async function readVoiceAgents(client, workspace) {
  if (!workspace?.id || !workspace.projectKey) throw fail('MISSING_SCOPE', '工作区缺少项目标识，请重新列出工作区。');
  const entries = await collectPages(cursor => client.agents.list({
    filter: { projectKeys: [workspace.projectKey], includeArchived: false },
    page: { limit: 50, ...(cursor ? { cursor } : {}) },
  }));
  return entries.map(entry => entry.agent).filter(a => a?.workspaceId === workspace.id && !a.archivedAt)
    .map(a => ({ id: a.id, workspaceId: a.workspaceId, name: a.title ?? '未命名 Agent', status: a.status }));
}

/** Lists metadata within an explicit project search; never starts or changes an agent. */
export async function readDirectory(client, { query }) {
  query = requireText(query, '工作区搜索词');
  const workspaces = await collectPages(cursor => client.workspaces.list({
    filter: { query }, page: { limit: 50, ...(cursor ? { cursor } : {}) },
  }));
  if (!workspaces.length) return { workspaces: [], agents: [] };
  const projectKeys = [...new Set(workspaces.map(w => w.project?.projectKey))];
  if (projectKeys.some(key => typeof key !== 'string' || !key)) {
    throw fail('MISSING_SCOPE', '工作区缺少项目标识，已停止读取 Agent 列表。');
  }
  const workspaceIds = new Set(workspaces.map(w => w.id));
  const entries = await collectPages(cursor => client.agents.list({
    filter: { projectKeys, includeArchived: false },
    page: { limit: 50, ...(cursor ? { cursor } : {}) },
  }));
  return {
    workspaces: workspaces.map(w => ({
      id: w.id, projectId: w.projectId, name: w.title ?? w.name, status: w.status,
    })),
    agents: entries.map(e => e.agent).filter(a => workspaceIds.has(a.workspaceId)).map(a => ({
      id: a.id, workspaceId: a.workspaceId, title: a.title ?? null, status: a.status,
    })),
  };
}

/** Reads one explicitly selected conversation. Text is returned only when requested. */
export async function readConversation(client, { agentId, limit = 20, includeText = false }) {
  agentId = requireText(agentId, 'Agent ID');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw fail('INVALID_INPUT', '历史页大小必须是 1 到 100 的整数。');
  }
  const handle = client.agents.ref(agentId);
  const refreshed = await handle.refresh();
  if (!refreshed) throw fail('AGENT_NOT_FOUND', '指定 Agent 不存在。');
  const snapshot = refreshed.agent;
  if (snapshot?.id !== agentId) throw fail('IDENTITY_MISMATCH', 'Agent 身份不匹配。');
  const page = await handle.timeline.refetch({ direction: 'before', limit, projection: 'projected' });
  if (page.agentId !== agentId) throw fail('IDENTITY_MISMATCH', '历史不属于指定 Agent。');
  if (page.error || !Array.isArray(page.entries)) {
    throw fail('HISTORY_FAILED', '消息历史读取失败。');
  }
  return {
    agent: {
      id: snapshot.id, workspaceId: snapshot.workspaceId ?? null,
      status: snapshot.status, model: snapshot.model ?? null,
      needsPermission: Boolean(snapshot.pendingPermissions?.length),
    },
    history: {
      epoch: page.epoch, startCursor: page.startCursor ?? null, endCursor: page.endCursor ?? null,
      hasOlder: page.hasOlder, hasNewer: page.hasNewer, fetchedEntries: page.entries.length,
      messages: page.entries.flatMap(entry => {
        const item = entry.item;
        if (!['user_message', 'assistant_message'].includes(item?.type)) return [];
        if (typeof item.text !== 'string') throw fail('HISTORY_FAILED', '消息文本格式无法识别。');
        return [{
          role: item.type === 'user_message' ? 'user' : 'assistant',
          seqStart: entry.seqStart, seqEnd: entry.seqEnd, characters: [...item.text].length,
          ...(includeText ? { text: item.text } : {}),
        }];
      }),
    },
  };
}
