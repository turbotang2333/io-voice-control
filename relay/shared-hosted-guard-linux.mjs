import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { isSafeSharedNode } from './shared-infrastructure.mjs';
import { createSharedHostedSystemdService } from './shared-hosted-systemd-service.mjs';
import { createSharedHostedGuardPlan } from './shared-hosted-upgrade-guard-plan.mjs';

const fail = () => Object.assign(Error('SHARED_UPGRADE_GUARD_INSTALL_INVALID'), { code: 'SHARED_UPGRADE_GUARD_INSTALL_INVALID' });

export function createSharedHostedGuardLinuxDriver({ root, nodePath, service, reload } = {}) {
  if (!isAbsolute(root ?? '')) throw fail();
  root = resolve(root); const production = root === '/';
  if (production) {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0 || service !== undefined || reload !== undefined || !isSafeSharedNode(nodePath)) throw fail();
    service = createSharedHostedSystemdService();
    reload = () => execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe', timeout: 30000 });
  }
  if (!service || typeof service.isActive !== 'function' || typeof service.guardReady !== 'function' || typeof reload !== 'function') throw fail();
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail();
  if (!production) { const marker = lstatSync(join(root, '.rayneo-upgrade-test-only')); if (!marker.isFile() || marker.isSymbolicLink()) throw fail(); }
  const plan = createSharedHostedGuardPlan({ nodePath }), created = [];
  const local = path => {
    if (![plan.guardPath, plan.dropInPath, plan.lockPath, '/var/lib/rayneo-paseo-shared-hosted/upgrade-backup', '/var/lib/rayneo-paseo-shared-hosted/upgrade-backup.prepare'].includes(path)) throw fail();
    const full = join(root, path.slice(1)); if (!production && !full.startsWith(root + sep)) throw fail();
    let parent = dirname(full);
    while (true) {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) throw fail();
      if (parent === root) break;
      const next = dirname(parent); if (next === parent) throw fail(); parent = next;
    }
    return full;
  };
  const exists = path => { try { lstatSync(local(path)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const syncDir = path => { if (process.platform === 'win32') return; const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const checkPlan = input => {
    if (!input || input.guardPath !== plan.guardPath || input.dropInPath !== plan.dropInPath || input.lockPath !== plan.lockPath || input.dropIn !== plan.dropIn
      || !Buffer.isBuffer(input.guardSource) || !input.guardSource.equals(plan.guardSource)) throw fail();
  };
  const create = (path, content, mode = 0o644) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content), full = local(path);
    const fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    const record = { path, inode: fstatSync(fd).ino, bytes }; created.push(record);
    try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
    syncDir(dirname(full));
    return record;
  };
  return {
    async preflight(input) {
      checkPlan(input);
      if (await service.isActive() !== true || exists(plan.guardPath) || exists(plan.dropInPath) || exists(plan.lockPath)
        || exists('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup') || exists('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup.prepare')) throw fail();
    },
    async createLock(input) {
      checkPlan(input);
      const record = create(plan.lockPath, Buffer.alloc(0), 0o600), full = local(plan.lockPath);
      const db = new DatabaseSync(full);
      try { db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE guard (id INTEGER)'); } finally { db.close(); }
      record.bytes = readFileSync(full);
      if (process.platform !== 'win32') { const fd = openSync(full, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
      syncDir(dirname(full));
    },
    async createGuard(input) { checkPlan(input); create(plan.guardPath, plan.guardSource); },
    async createDropIn(input) { checkPlan(input); create(plan.dropInPath, plan.dropIn); },
    async reload() { await reload(); },
    async verify() { return await service.isActive() === true && await service.guardReady(nodePath) === true; },
    async rollback() {
      for (const item of created) {
        const full = local(item.path), s = lstatSync(full);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.ino !== item.inode || production && (s.uid !== 0 || (s.mode & 0o022))) throw fail();
        const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const current = fstatSync(fd); if (current.ino !== s.ino || current.dev !== s.dev || !readFileSync(fd).equals(item.bytes)) throw fail(); }
        finally { closeSync(fd); }
      }
      for (const item of [...created].reverse()) { const full = local(item.path); unlinkSync(full); syncDir(dirname(full)); }
      if (created.length) await reload();
      if (await service.isActive() !== true) throw fail();
    },
  };
}
