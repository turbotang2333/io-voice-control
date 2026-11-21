import { createHash } from 'node:crypto';
import { readVoiceWorkspaces } from './reader.mjs';
import { createCodexHistoryReader } from './codex-history.mjs';
import { createSearchEmbeddings } from './search-embeddings.mjs';

const fail = code => Object.assign(new Error('搜索名单已变化，请重新查找对话。'), { code });
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const label = value => String(value ?? '未命名对话').replace(/[\r\n]+/gu, ' ').slice(0, 100);
const filler = /相关的|相关|关于|里面|中的|查找|对话|项目|之前|一个|一下|那个|我的|的|里|下/gu;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const hash = text => createHash('sha256').update(text).digest('hex');
const similarity = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const split = text => { const chars = [...text], chunks = []; for (let at = 0; at < chars.length; at += 240) chunks.push(chars.slice(at, at + 280).join('')); return chunks; };
async function collect(fetch) {
  const entries = [], seen = new Set(); let cursor;
  do {
    const page = await fetch(cursor);
    if (!Array.isArray(page?.entries) || !page.pageInfo) throw fail('SEARCH_READ_FAILED');
    entries.push(...page.entries); cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw fail('SEARCH_READ_FAILED');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return entries;
}
async function directory(client) {
  const workspaces = await readVoiceWorkspaces(client);
  if (workspaces.some(w => !w.id || !w.projectKey)) throw fail('SEARCH_READ_FAILED');
  const entries = workspaces.length ? await collect(cursor => client.agents.list({
    filter: { projectKeys: [...new Set(workspaces.map(w => w.projectKey))], includeArchived: false },
    page: { limit: 50, ...(cursor ? { cursor } : {}) },
  })) : [];
  const byWorkspace = new Map(workspaces.map(w => [w.id, w]));
  const agents = new Map();
  for (const { agent } of entries) {
    if (!agent || agent.archivedAt || agent.internal || !byWorkspace.has(agent.workspaceId)) continue;
    if (typeof agent.id !== 'string' || (agents.has(agent.id) && agents.get(agent.id).workspaceId !== agent.workspaceId)) throw fail('SEARCH_READ_FAILED');
    agents.set(agent.id, { ...agent });
  }
  return { workspaces, byWorkspace, agents };
}
function parseQuery(query, workspaces, aliases) {
  let topic = normalize(query);
  const matches = [];
  for (const workspace of workspaces) {
    const names = [workspace.name, workspace.name.replaceAll('-', ''), ...(aliases[normalize(workspace.name)] ?? [])]
      .map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const name of names) if (topic.includes(name)) matches.push({ id: workspace.id, name, at: topic.indexOf(name) });
  }
  matches.sort((a, b) => a.at - b.at || b.name.length - a.name.length);
  const first = matches[0], projectMarker = /项目(?:里面|里|下|中|的)/u.exec(topic);
  if (projectMarker && (!first || first.at > projectMarker.index)) return { reason: 'unknown-project', ids: [], topic: '' };
  // Only the first project restriction is scope. Later project names remain searchable topic text.
  const selected = first ? matches.filter(m => m.at === first.at && m.name === first.name).map(m => m.id) : workspaces.map(w => w.id);
  if (first) topic = topic.slice(0, first.at) + topic.slice(first.at + first.name.length);
  topic = topic.replace(filler, '').replace(/^[，。,:：]+|[，。,:：]+$/gu, '');
  const terms = [...new Set([...segmenter.segment(topic)].filter(s => s.isWordLike).map(s => normalize(s.segment)).filter(s => s.length > 0))];
  return { ids: selected, topic, terms, reason: terms.length ? null : 'empty-query' };
}

export function normalizeProjectAliases(projectAliases) {
  if (!projectAliases || typeof projectAliases !== 'object' || Array.isArray(projectAliases) || Object.keys(projectAliases).length > 1000) throw fail('SEARCH_INVALID');
  const aliases = Object.create(null);
  for (const [name, names] of Object.entries(projectAliases)) {
    if (name.length > 100 || !Array.isArray(names) || names.length > 20 || names.some(v => typeof v !== 'string' || !v.trim() || v.length > 100 || /[\p{Cc}\p{Cf}]/u.test(v))) throw fail('SEARCH_INVALID');
    aliases[normalize(name)] = [...names];
  }
  return aliases;
}

/** Ephemeral index. No chat text, query, title or embeddings are persisted. */
export function createConversationSearch(client, { history = createCodexHistoryReader(), embed = createSearchEmbeddings(),
  now = Date.now, refreshMs = 0, maxChunks = 30000, cacheMs = 30000, titleFirst = false, indexBudgetMs = Infinity, projectAliases = {} } = {}) {
  const aliases = normalizeProjectAliases(projectAliases);
  if (!Number.isFinite(cacheMs) || cacheMs < 0) throw fail('SEARCH_INVALID');
  if (typeof titleFirst !== 'boolean' || !(indexBudgetMs === Infinity || Number.isFinite(indexBudgetMs) && indexBudgetMs > 0)) throw fail('SEARCH_INVALID');
  const cache = new Map(), vectors = new Map(), snapshots = new WeakSet(), watched = new Set();
  let tail = Promise.resolve(), closed = false, semanticAvailable = true, backgroundPending = false, closing, embeddingWork;
  const serial = work => { const job = tail.then(() => { if (closed) throw fail('SEARCH_CLOSED'); return work(); }); tail = job.catch(() => {}); return job; };
  const signature = a => JSON.stringify([a.workspaceId, a.provider, a.persistence, a.title, a.updatedAt, a.lastUserMessageAt]);
  const publicItem = (a, workspace, bodyCoverage) => Object.freeze({ id: a.id, agentId: a.id, workspaceId: workspace.id,
    projectKey: workspace.projectKey, workspaceName: label(workspace.name), name: label(a.title), status: a.status, bodyCoverage });
  function budget(assertCurrent) {
    const deadline = performance.now() + indexBudgetMs;
    let exhausted = false;
    const check = () => {
      if (closed) throw fail('SEARCH_CLOSED'); assertCurrent?.();
      if (exhausted || performance.now() >= deadline) throw fail('SEARCH_BUDGET');
    };
    return {
      finite: Number.isFinite(indexBudgetMs), get expired() { return exhausted || performance.now() >= deadline; }, check,
      async call(work) {
        check();
        if (!Number.isFinite(indexBudgetMs)) return work();
        let timer;
        try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
          timer = setTimeout(() => { exhausted = true; reject(fail('SEARCH_BUDGET')); }, Math.max(1, deadline - performance.now()));
        })]); } finally { clearTimeout(timer); }
      },
    };
  }
  async function infer(texts, limit) {
    // A timed-out native inference can finish, but no later search may queue work behind it.
    while (embeddingWork) await limit.call(() => embeddingWork.catch(() => {}));
    limit.check();
    const job = Promise.resolve().then(() => embed(texts));
    embeddingWork = job;
    const clear = () => { if (embeddingWork === job) embeddingWork = undefined; };
    job.then(clear, clear);
    return limit.call(() => job);
  }
  async function sync(dir, ids, assertCurrent, limit = budget(assertCurrent)) {
    const current = () => { if (closed) throw fail('SEARCH_CLOSED'); assertCurrent?.(); };
    const checked = new Set();
    const live = new Set(dir.agents.keys());
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    async function prepareModel() {
      try { await infer([], limit); semanticAvailable = true; } catch { current(); semanticAvailable = false; }
    }
    async function embedChunks(indexed) {
      const missing = indexed.chunks.filter(c => !vectors.has(c.key));
      try {
        for (let i = 0; i < missing.length; i += 4) {
          limit.check();
          const batch = missing.slice(i, i + 4), output = await infer(batch.map(c => c.text), limit);
          if (output.length !== batch.length || output.some(v => !Array.isArray(v) || !v.length || v.some(n => !Number.isFinite(n)))) throw fail('SEARCH_MODEL_FAILED');
          output.forEach((v, j) => vectors.set(batch[j].key, Float32Array.from(v)));
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch { current(); semanticAvailable = false; }
    }
    // Interactive calls collect keyword text before spending their budget on semantic inference.
    if (!limit.finite) await prepareModel();
    else semanticAvailable = false;
    let remaining = maxChunks;
    for (const agent of dir.agents.values()) {
      if (!ids.includes(agent.workspaceId)) continue;
      current();
      if (limit.expired) break;
      const previous = cache.get(agent.id), key = signature(agent);
      let indexed = previous;
      if (!(previous?.key === key && agent.status !== 'running' && now() - previous.readAt < cacheMs)) {
      let body = { messages: [], complete: false };
      if (agent.provider === 'codex') {
        try { body = await limit.call(() => history.read(agent, { assertCurrent: limit.check })); }
        catch { /* This entry becomes title-only, never stale body. */ }
      }
      current();
      const raw = [agent.title ?? '未命名对话', ...body.messages.flatMap(split)];
      const unique = [...new Map(raw.map(text => [hash(text), text])).entries()];
      const chunks = unique.slice(0, Math.max(1, remaining)).map(([key, text]) => ({ key, text, normalized: normalize(text) }));
      const complete = body.complete && chunks.length === unique.length;
      indexed = { key, chunks, readAt: now(), coverage: body.messages.length ? complete ? 'complete' : 'partial' : body.complete ? 'complete' : 'title-only' };
      cache.set(agent.id, indexed);
      }
      remaining = Math.max(0, remaining - indexed.chunks.length);
      checked.add(agent.id);
      if (!limit.finite && semanticAvailable) await embedChunks(indexed);
    }
    if (limit.finite && !limit.expired) {
      await prepareModel();
      for (const [id, indexed] of cache) {
        if (!semanticAvailable || limit.expired) break;
        if (ids.includes(dir.agents.get(id)?.workspaceId)) await embedChunks(indexed);
      }
    }
    let retained = [...cache.values()].reduce((n, c) => n + c.chunks.length, 0);
    for (const [id, item] of cache) {
      if (retained <= maxChunks) break;
      if (!ids.includes(dir.agents.get(id)?.workspaceId)) { cache.delete(id); retained -= item.chunks.length; }
    }
    const used = new Set([...cache.values()].flatMap(c => c.chunks.map(c => c.key)));
    for (const key of vectors.keys()) if (!used.has(key)) vectors.delete(key);
    return checked;
  }
  const timer = refreshMs > 0 ? setInterval(() => {
    if (!closed && watched.size && !backgroundPending) {
      backgroundPending = true;
      serial(async () => { const dir = await directory(client); await sync(dir, [...watched]); }).catch(() => {}).finally(() => { backgroundPending = false; });
    }
  }, refreshMs).unref() : undefined;
  function snapshot(items, scopeKey, details = {}) {
    const value = Object.freeze({ items: Object.freeze(items), scopeKey, fetchedAt: now(), expiresAt: now() + 120000, ...details });
    snapshots.add(value); return value;
  }
  return {
    search(query, { scopeKey, assertCurrent } = {}) {
      return serial(async () => {
        assertCurrent?.();
        if (typeof query !== 'string' || [...query].length > 200 || typeof scopeKey !== 'string' || !scopeKey) throw fail('SEARCH_INVALID');
        const dir = await directory(client), parsed = parseQuery(query, dir.workspaces, aliases);
        if (parsed.reason) return snapshot([], scopeKey, { reason: parsed.reason, coverage: 'complete' });
        if (titleFirst) {
          const matches = [...dir.agents.values()].filter(a => parsed.ids.includes(a.workspaceId)
            && normalize(a.title).includes(parsed.topic)).sort((a, b) => a.id.localeCompare(b.id));
          if (matches.length) {
            assertCurrent?.();
            return snapshot(matches.slice(0, 5).map(a => publicItem(a, dir.byWorkspace.get(a.workspaceId), 'title-only')),
              scopeKey, { coverage: 'partial', semanticAvailable: false, reason: null });
          }
        }
        parsed.ids.forEach(id => watched.add(id));
        const limit = budget(assertCurrent);
        const checked = await sync(dir, parsed.ids, assertCurrent, limit);
        const latest = await directory(client); // Do not publish candidates archived during indexing.
        assertCurrent?.();
        const candidates = []; let omitted = false;
        for (const a of latest.agents.values()) {
          let indexed = cache.get(a.id);
          const workspace = latest.byWorkspace.get(a.workspaceId);
          if (!parsed.ids.includes(a.workspaceId)) continue;
          if (!indexed || limit.finite && !checked.has(a.id) || indexed.key !== signature(a)
            || dir.byWorkspace.get(a.workspaceId)?.projectKey !== workspace.projectKey) {
            omitted = true;
            if (!limit.finite) continue;
            // Still offer freshly verified titles when the body indexing budget was exhausted.
            indexed = { chunks: [{ normalized: normalize(a.title) }], coverage: 'title-only' };
          }
          candidates.push({ a, indexed, item: publicItem(a, workspace, indexed.coverage) });
        }
        const keywords = candidates.map(c => ({ ...c, score: parsed.terms.reduce((sum, term) => sum
          + (normalize(c.a.title).includes(term) ? 3 : 0) + (c.indexed.chunks.some(ch => ch.normalized.includes(term)) ? 1 : 0), 0) }))
          .filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.a.id.localeCompare(b.a.id));
        let semantic = [];
        if (semanticAvailable && !limit.expired) {
          try {
            const [queryVector] = await infer(['为这个句子生成表示以用于检索相关文章：' + parsed.topic], limit);
            semantic = candidates.map(c => ({ ...c, score: Math.max(-1, ...c.indexed.chunks.map(ch => vectors.has(ch.key) ? similarity(queryVector, vectors.get(ch.key)) : -1)) }))
              .filter(c => c.score >= 0.45).sort((a, b) => b.score - a.score || a.a.id.localeCompare(b.a.id));
          } catch { semanticAvailable = false; }
        }
        assertCurrent?.();
        const ranked = candidates.map(c => ({ ...c, score: [keywords, semantic].reduce((sum, list) => {
          const rank = list.findIndex(r => r.a.id === c.a.id); return sum + (rank < 0 ? 0 : 1 / (61 + rank));
        }, 0) })).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.a.id.localeCompare(b.a.id));
        return snapshot(ranked.slice(0, 5).map(c => c.item), scopeKey, { coverage: limit.expired || omitted || candidates.some(c => c.indexed.coverage !== 'complete') ? 'partial' : 'complete',
          semanticAvailable, reason: ranked.length ? null : 'no-results' });
      });
    },
    async resolve({ snapshot: value, itemIndex, scopeKey } = {}) {
      const valid = () => snapshots.has(value) && value.scopeKey === scopeKey && now() >= value.fetchedAt && now() < value.expiresAt
        && Number.isInteger(itemIndex) && itemIndex >= 0 && itemIndex < value.items.length;
      if (!valid()) throw fail('SEARCH_STALE');
      const item = value.items[itemIndex], workspaces = await readVoiceWorkspaces(client);
      const workspace = workspaces.find(w => w.id === item.workspaceId && w.projectKey === item.projectKey);
      const a = (await client.agents.ref(item.agentId).refresh())?.agent;
      if (!valid() || !workspace || !a || a.id !== item.agentId || a.workspaceId !== workspace.id || a.archivedAt || a.internal) throw fail('SEARCH_STALE');
      return publicItem(a, workspace, item.bodyCoverage);
    },
    close() {
      if (!closing) {
        closed = true; clearInterval(timer);
        closing = (async () => { await Promise.allSettled([Promise.resolve().then(() => history.close?.()), tail]);
          cache.clear(); vectors.clear(); await embed.close?.(); })();
      }
      return closing;
    },
  };
}
