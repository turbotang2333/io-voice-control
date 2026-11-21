const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const invalid = () => Object.assign(new Error('RECENT_METADATA_INVALID'), { code: 'RECENT_METADATA_INVALID' });

async function lastUserTime(client, id, check) {
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    check();
    const response = await client.userTimePage(id, cursor);
    check();
    if (!Array.isArray(response?.data)) throw invalid();
    for (const turn of response.data) {
      if (!Array.isArray(turn?.items)) throw invalid();
      const users = turn.items.filter(item => item.type === 'userMessage');
      if (users.length) {
        // A missing timestamp on the latest user input cannot be replaced with
        // an older input, a turn start, or a thread/file modification time.
        if (users.some(item => !time(item.startedAtMs))) throw invalid();
        return Math.max(...users.map(item => item.startedAtMs));
      }
    }
    if (response.nextCursor == null) return null;
    if (typeof response.nextCursor !== 'string' || !response.nextCursor || seen.has(response.nextCursor)) throw invalid();
    cursor = response.nextCursor; seen.add(cursor);
  }
  throw invalid();
}

/** Reads only projected item types/times; never persists conversation content. */
export async function readRecentConversations(client, catalog, { assertCurrent = () => {} } = {}) {
  const projects = new Map(catalog.projects.map(p => [p.id, p.name]));
  let position = 0, omitted = 0;
  const items = [];
  async function worker() {
    while (position < catalog.threads.length) {
      assertCurrent();
      const thread = catalog.threads[position++];
      try {
        const lastUserAt = await lastUserTime(client, thread.id, assertCurrent);
        if (lastUserAt !== null && projects.has(thread.projectId)) {
          items.push({ ...thread, projectName: projects.get(thread.projectId), lastUserAt });
        }
      } catch (error) {
        if (/^NAVIGATION_/.test(error?.code ?? '')) throw error;
        omitted++;
      }
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, catalog.threads.length) }, worker));
  const failure = outcomes.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  assertCurrent();
  items.sort((a, b) => b.lastUserAt - a.lastUserAt
    || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, partial: omitted > 0 };
}
