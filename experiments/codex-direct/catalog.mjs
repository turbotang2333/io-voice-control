import { win32, posix } from 'node:path';

export const label = text => String(text).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
export function directoryKey(value) {
  if (typeof value !== 'string' || !value) return null;
  if (win32.isAbsolute(value)) return win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  return posix.isAbsolute(value) ? posix.normalize(value).replace(/\/+$/, '') || '/' : null;
}
export function directoryName(value) {
  return label(win32.isAbsolute(value) ? win32.basename(value) : posix.basename(value)) || '根目录';
}

// Discard preview and turns at the boundary: neither is a user-assigned title.
export async function readThreadMetadata(rpc, cwd, { excludeIds = [process.env.CODEX_THREAD_ID].filter(Boolean) } = {}) {
  const items = [], seen = new Set();
  let cursor;
  do {
    const page = await rpc.request('thread/list', { limit: 100, sourceKinds: ['cli', 'vscode', 'appServer'],
      archived: false, useStateDbOnly: true, ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('INVALID_CATALOG');
    for (const entry of page.data) {
      const key = directoryKey(entry.cwd);
      if (typeof entry.id !== 'string' || excludeIds.includes(entry.id) || !key || entry.ephemeral || (cwd && key !== directoryKey(cwd))) continue;
      items.push({ id: entry.id, cwd: entry.cwd, key,
        name: label(entry.name || `未命名会话 ${entry.id.slice(-8)}`), status: entry.status?.type ?? 'notLoaded' });
    }
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || seen.has(cursor) || seen.size >= 100)) throw new Error('INVALID_CATALOG');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
