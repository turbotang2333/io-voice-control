import { QueueClient } from './client.mjs';
import { readCatalog, projectForThread } from './catalog.mjs';
import { createConversationSearch } from '../../bridge/conversation-search.mjs';
import { createCodexHistoryReader } from '../../bridge/codex-history.mjs';

const fail = code => Object.assign(new Error(code), { code });

/** Reuses local search with a separate, lazy reader that cannot submit tasks. */
export function createConnectorSearch(source, { readerFactory = options => new QueueClient(options),
  embed, now = Date.now, refreshMs = 0, indexBudgetMs = 10000, projectAliases = {} } = {}) {
  let reader, opening, closed = false, activeCatalog;
  async function ensure() {
    if (closed) throw fail('SEARCH_CLOSED');
    if (reader?.ready) return reader;
    if (!opening) opening = (async () => {
      await reader?.close();
      reader = readerFactory({ executable: source.executable, codexHome: source.codexHome, catalog: true, readOnly: true });
      await reader.connect();
      if (closed) { await reader.close(); throw fail('SEARCH_CLOSED'); }
      return reader;
    })().finally(() => { opening = undefined; });
    return opening;
  }
  async function catalog() {
    const value = await readCatalog(await ensure());
    if (closed) throw fail('SEARCH_CLOSED');
    activeCatalog = value; return value;
  }
  const agent = thread => thread && ({ id: thread.id, title: thread.name, workspaceId: thread.projectId,
    cwd: thread.cwd, provider: 'codex', persistence: { provider: 'codex', nativeHandle: thread.id },
    status: thread.status === 'active' ? 'running' : 'closed',
    updatedAt: JSON.stringify([thread.updatedAt, thread.recencyAt]) });
  const facade = {
    workspaces: { async list() { const value = await catalog(); return { entries: value.projects.map(p =>
      ({ id: p.id, title: p.name, project: { projectKey: p.id } })), pageInfo: {} }; } },
    agents: {
      async list({ filter }) { const value = await catalog(); return { entries: value.threads
        .filter(t => filter.projectKeys.includes(t.projectId)).map(t => ({ agent: agent(t) })), pageInfo: {} }; },
      ref: id => ({ async refresh() { return { agent: agent((await catalog()).threads.find(t => t.id === id)) }; } }),
    },
  };
  const history = {
    async read(value, { assertCurrent } = {}) {
      assertCurrent?.();
      const c = await ensure();
      if (c.knownThreads && !c.knownThreads.has(value.id)) await catalog();
      assertCurrent?.();
      const expectedCatalog = activeCatalog;
      const scoped = createCodexHistoryReader({ maxCharacters: 64 * 1024, request: async (method, params) => {
        assertCurrent?.();
        if (params.threadId !== value.id) throw fail('SEARCH_HISTORY_FAILED');
        if (method === 'thread/read') {
          const snapshot = await c.bindThread(value.id).snapshot();
          assertCurrent?.();
          if (projectForThread(snapshot, expectedCatalog) !== value.workspaceId) throw fail('SEARCH_STALE');
          return { thread: snapshot };
        }
        if (method !== 'thread/turns/list') throw fail('METHOD_NOT_ALLOWED');
        const result = await c.request(method, { ...params, limit: 10 });
        assertCurrent?.(); return result;
      } });
      try { return await scoped.read(value); } finally { await scoped.close(); }
    },
    async close() { closed = true; await reader?.close(); await opening?.catch(() => {}); },
  };
  return createConversationSearch(facade, { history, ...(embed ? { embed } : {}), now, refreshMs, cacheMs: 0,
    titleFirst: true, indexBudgetMs, maxChunks: 1024, projectAliases });
}
