import { createHash } from 'node:crypto';
import { QueueClient } from './client.mjs';
import { readCatalog, projectForThread, label } from './catalog.mjs';
import { validId } from './journal.mjs';
import { createDesktopWake } from './wake.mjs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
const fail = code => Object.assign(new Error(code), { code });
const key = name => name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const directory = path => typeof path === 'string' && win32.isAbsolute(path) ? win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase() : null;
function activeRollout(snapshot, codexHome) {
  let path = snapshot?.path;
  if (typeof path !== 'string') return false;
  if (path.startsWith('\\\\?\\')) path = path.slice(4);
  if (!win32.isAbsolute(path)) return false;
  const relative = win32.relative(win32.join(codexHome ?? win32.join(homedir(), '.codex'), 'sessions'), path);
  return Boolean(relative) && !win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\');
}

/** Empty native threads are hidden from ordinary listings until their first user input.
 * Keep only our own verified empty threads visible; native Codex remains the metadata authority. */
export function createConnectorCreation(client, { store, enabled = true, creatorFactory = options => new QueueClient(options), wake = createDesktopWake() } = {}) {
  let busy = false, closed = false;
  const creators = new Set(), originalPage = client.threadPage;
  const supported = () => enabled === true && !closed && Boolean(store) && wake.available() && client.isDesktopAvailable();
  const guard = assertCurrent => { assertCurrent?.(); if (closed) throw fail('CREATION_UNSUPPORTED'); };
  const page = async cursor => {
    const native = await originalPage.call(client, cursor);
    const known = new Set(native.data.map(t => t.id));
    for (const r of store.records()) if (r.status === 'created' && known.has(r.threadId)) store.listed(r.requestId);
    if (cursor) return native;
    const extra = [];
    for (const r of store.records().filter(r => r.status === 'created' && !known.has(r.threadId))) {
      let snapshot;
      try { snapshot = await client.storedCreationSnapshot(r.threadId); }
      catch (e) { if (e.code === 'CODEX_RPC_REJECTED' || e.code === 'INVALID_TARGET') continue; throw e; }
      if (snapshot?.id !== r.threadId || snapshot.projectId !== r.projectId || snapshot.ephemeral || snapshot.canAcceptDirectInput === false || !activeRollout(snapshot, client.codexHome)
        || (typeof snapshot.source === 'object' && snapshot.source && 'subAgent' in snapshot.source)) continue;
      extra.push(snapshot); client.knownThreads.add(snapshot.id);
    }
    return { ...native, data: [...native.data, ...extra] };
  };
  client.threadPage = page;
  return {
    supported,
    async wakeQueued(threadId) {
      if (closed) throw fail('CREATION_UNSUPPORTED');
      if (store.records().some(r => r.threadId === threadId && ['created', 'listed'].includes(r.status))) await wake.run(threadId);
    },
    async create({ requestId, title, projectId, assertCurrent, onUpdate } = {}) {
      guard(assertCurrent);
      if (!supported() || busy) throw fail('CREATION_UNSUPPORTED');
      if (!validId(requestId)) throw fail('INVALID_INPUT');
      if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 40 || /[\p{Cc}\p{Cf}]/u.test(title)) throw fail('CREATION_NAME');
      title = title.trim();
      if (store.get(requestId)) throw fail('CREATION_REPLAY');
      const records = store.records();
      if (records.some(r => r.projectId === projectId && r.status === 'reserved')) throw fail('CREATION_UNCERTAIN');
      const nameHash = createHash('sha256').update(key(title)).digest('hex');
      if (records.some(r => r.projectId === projectId && r.nameHash === nameHash)) throw fail('CREATION_DUPLICATE');
      busy = true; let creator, reserved = false;
      try {
        const catalog = await readCatalog(client); guard(assertCurrent);
        const project = catalog.projects.find(p => p.id === projectId && !p.derived);
        if (!project || project.rootKeys.length !== 1) throw fail('CREATION_SCOPE');
        if (catalog.threads.some(t => t.projectId === projectId && key(t.name) === key(title))) throw fail('CREATION_DUPLICATE');
        if (!supported()) throw fail('CREATION_UNSUPPORTED');
        try { onUpdate?.({ type: 'state', state: 'creating' }); } catch {}
        creator = creatorFactory({ executable: client.executable, codexHome: client.codexHome,
          creationScope: { projectId, cwd: project.rootKeys[0] } }); creators.add(creator);
        await creator.connect(); guard(assertCurrent);
        const refreshed = await readCatalog(client); guard(assertCurrent);
        const latest = refreshed.projects.find(p => p.id === projectId && !p.derived);
        if (latest?.rootKeys.length !== 1 || latest.rootKeys[0] !== project.rootKeys[0]) throw fail('CREATION_SCOPE');
        if (refreshed.threads.some(t => t.projectId === projectId && key(t.name) === key(title))) throw fail('CREATION_DUPLICATE');
        store.reserve(requestId, projectId, nameHash); reserved = true;
        const snapshot = await creator.createEmpty(title, id => store.assign(requestId, id));
        guard(assertCurrent);
        const finalProject = (await readCatalog(client)).projects.find(p => p.id === projectId && !p.derived); guard(assertCurrent);
        if (snapshot?.projectId !== projectId || projectForThread(snapshot, catalog) !== projectId || snapshot.name !== title
          || !validId(snapshot.id) || snapshot.ephemeral || snapshot.canAcceptDirectInput === false || !activeRollout(snapshot, client.codexHome)
          || directory(snapshot.cwd) !== project.rootKeys[0] || finalProject?.rootKeys.length !== 1
          || finalProject.rootKeys[0] !== project.rootKeys[0]) throw fail('CREATION_UNCERTAIN');
        store.finish(requestId);
        return { threadId: snapshot.id, projectId, name: label(snapshot.name), projectName: label(project.name) };
      } catch (error) {
        if (/^NAVIGATION_/.test(error?.code ?? '')) throw error;
        if (!reserved) throw error;
        throw fail('CREATION_UNCERTAIN');
      } finally { try { if (creator) { await creator.close(); creators.delete(creator); } } finally { busy = false; } }
    },
    async close() {
      closed = true; if (client.threadPage === page) client.threadPage = originalPage;
      await Promise.allSettled([...creators].map(c => c.close())); creators.clear();
    },
  };
}
