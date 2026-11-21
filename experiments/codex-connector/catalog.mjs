import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { validId } from './journal.mjs';

const fail = () => Object.assign(new Error('CATALOG_INVALID'), { code: 'CATALOG_INVALID' });
export const label = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 60);
const directory = value => typeof value === 'string' && win32.isAbsolute(value)
  ? win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() : null;
const directoryId = key => 'dir_' + createHash('sha256').update(key).digest('hex');
const unassigned = 'unassigned';

async function pages(read) {
  const result = [], cursors = new Set();
  let cursor;
  for (let n = 0; n < 100; n++) {
    const page = await read(cursor);
    if (!Array.isArray(page?.data)) throw fail();
    result.push(...page.data);
    if (page.nextCursor == null) return result;
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) throw fail();
    cursor = page.nextCursor; cursors.add(cursor);
  }
  throw fail(); // Never silently turn a partial catalog into a selectable complete list.
}

export function projectForThread(thread, catalog) {
  if (thread?.projectId != null) return catalog.projects.some(p => !p.derived && p.id === thread.projectId) ? thread.projectId : null;
  const key = directory(thread?.cwd);
  if (!key) return catalog.projects.some(p => p.id === unassigned) ? unassigned : null;
  const exact = catalog.projects.filter(p => !p.derived && p.rootKeys.includes(key));
  if (exact.length === 1) return exact[0].id;
  const id = directoryId(key);
  return catalog.projects.some(p => p.id === id) ? id : null;
}

/** Metadata only. No history bodies, previews, tools, auth or task execution. */
export async function readCatalog(client) {
  const [rawProjects, rawThreads] = await Promise.all([
    pages(cursor => client.projectPage(cursor)), pages(cursor => client.threadPage(cursor)),
  ]);
  const projects = [], seenProjects = new Set(), threads = [], seenThreads = new Set();
  for (const p of rawProjects) {
    if (!validId(p?.id) || seenProjects.has(p.id) || !Array.isArray(p.roots)) throw fail();
    seenProjects.add(p.id);
    projects.push({ id: p.id, name: label(p.name || '未命名项目'), derived: false,
      rootKeys: p.roots.map(r => directory(r.path)).filter(Boolean) });
  }
  for (const t of rawThreads) {
    if (!validId(t?.id) || seenThreads.has(t.id) || t.ephemeral || t.canAcceptDirectInput === false
      || (typeof t.source === 'object' && t.source && 'subAgent' in t.source)) continue;
    seenThreads.add(t.id);
    if (t.projectId != null && !seenProjects.has(t.projectId)) continue;
    let projectId = projectForThread(t, { projects });
    if (!projectId) {
      const key = directory(t.cwd);
      projectId = key ? directoryId(key) : unassigned;
      if (seenProjects.has(projectId)) throw fail();
      seenProjects.add(projectId);
      projects.push({ id: projectId, name: key ? label(win32.basename(t.cwd)) : '未分组对话',
        derived: true, rootKeys: key ? [key] : [], directoryLabel: t.cwd });
    }
    threads.push({ id: t.id, name: label(t.name || '未命名对话'), projectId, cwd: t.cwd,
      updatedAt: t.updatedAt, recencyAt: t.recencyAt,
      status: typeof t.status === 'string' ? t.status : t.status?.type });
  }
  const counts = new Map();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  for (const p of projects) if (p.derived && counts.get(p.name) > 1 && p.directoryLabel) {
    p.name = String(p.directoryLabel).replace(/[\r\n\t]+/g, ' ').slice(-60);
  }
  return { projects, threads };
}
