import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const path = '/var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite';
const fail = () => Object.assign(Error('SHARED_UPGRADE_LOCK_UNAVAILABLE'), { code: 'SHARED_UPGRADE_LOCK_UNAVAILABLE' });

// The lock is held from before stopping the service until every source/config file is consistent.
export function acquireSharedUpgradeStartupLock({ root } = {}) {
  try {
    if (!isAbsolute(root ?? '')) throw fail(); root = resolve(root); const production = root === '/';
    if (production && (process.platform !== 'linux' || process.geteuid?.() !== 0)) throw fail();
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail();
    if (!production) { const marker = lstatSync(join(root, '.rayneo-upgrade-test-only')); if (!marker.isFile() || marker.isSymbolicLink()) throw fail(); }
    const full = join(root, path.slice(1)); if (!production && !full.startsWith(root + sep)) throw fail();
    let parent = dirname(full);
    while (true) {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) throw fail();
      if (parent === root) break;
      const next = dirname(parent); if (next === parent) throw fail(); parent = next;
    }
    const s = lstatSync(full);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || production && (s.uid !== 0 || (s.mode & 0o077))) throw fail();
    const db = new DatabaseSync(full, { timeout: 0 });
    try { db.exec('BEGIN IMMEDIATE'); } catch { db.close(); throw fail(); }
    let released = false;
    return { release() { if (!released) { released = true; try { db.exec('ROLLBACK'); } finally { db.close(); } } } };
  } catch { throw fail(); }
}
