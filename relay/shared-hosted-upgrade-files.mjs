import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createSharedInfrastructurePlan } from './shared-infrastructure.mjs';
import { validateSharedHostedLaunchConfig } from './shared-hosted-launch.mjs';

const configPath = '/etc/rayneo-paseo-shared/hosted.json';
const backupPath = '/var/lib/rayneo-paseo-shared-hosted/upgrade-backup';
const preparingPath = backupPath + '.prepare';
const additions = new Set(['/opt/rayneo-paseo-shared/relay/invite-store.mjs', '/opt/rayneo-paseo-shared/relay/invite-admin.mjs']);
const hash = data => createHash('sha256').update(data).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const conflict = () => Object.assign(Error('SHARED_UPGRADE_FILES_CONFLICT'), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
const unchangedConfig = (before, after) => {
  const value = JSON.parse(before.toString('utf8'));
  if (!value || Object.hasOwn(value, 'inviteDatabasePath')) return false;
  return isDeepStrictEqual(validateSharedHostedLaunchConfig({ ...value, inviteDatabasePath: '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite' }), after);
};

function context(input) {
  const root = resolve(input ?? '');
  if (!isAbsolute(input ?? '')) throw conflict();
  const production = root === '/';
  if (production && (process.platform !== 'linux' || process.geteuid?.() !== 0)) throw conflict();
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw conflict();
  if (!production) {
    const marker = lstatSync(join(root, '.rayneo-upgrade-test-only'));
    if (!marker.isFile() || marker.isSymbolicLink()) throw conflict();
  }
  const pathFor = path => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('\\')) throw conflict();
    const full = join(root, path.slice(1));
    if (!production && !full.startsWith(root + sep)) throw conflict();
    let parent = dirname(full);
    while (true) {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) throw conflict();
      if (parent === root) break;
      const next = dirname(parent); if (next === parent) throw conflict(); parent = next;
    }
    return full;
  };
  const read = (path, missing = false, privateFile = false) => {
    try {
      const full = pathFor(path), s = lstatSync(full);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 1024 * 1024
        || production && (s.uid !== 0 || (s.mode & (privateFile ? 0o077 : 0o022)))) throw conflict();
      const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const actual = fstatSync(fd); if (actual.ino !== s.ino || actual.dev !== s.dev) throw conflict(); return readFileSync(fd); }
      finally { closeSync(fd); }
    } catch (error) { if (missing && error.code === 'ENOENT') return null; throw conflict(); }
  };
  const syncDir = path => {
    if (process.platform === 'win32') return;
    const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const writeNew = (path, data, mode) => {
    const full = pathFor(path), fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    try { writeFileSync(fd, data); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
    syncDir(dirname(full));
  };
  const replace = (path, data, mode) => {
    const temp = path + '.upgrade-' + randomBytes(12).toString('hex');
    writeNew(temp, data, mode);
    const from = pathFor(temp), to = pathFor(path);
    renameSync(from, to); syncDir(dirname(to));
  };
  const remove = path => { const full = pathFor(path); unlinkSync(full); syncDir(dirname(full)); };
  const stopped = () => {
    if (!production) return;
    const state = execFileSync('systemctl', ['show', 'rayneo-shared-hosted.service', '--property=ActiveState', '--value'], { encoding: 'utf8', timeout: 10000 }).trim();
    if (!['inactive', 'failed'].includes(state)) throw conflict();
  };
  const mode = path => lstatSync(pathFor(path)).mode & 0o777;
  return { root, production, pathFor, read, writeNew, replace, remove, stopped, syncDir, mode };
}

function validateManifest(manifest, nextConfig) {
  const valid = validateSharedHostedLaunchConfig(nextConfig);
  const allowed = createSharedInfrastructurePlan(valid.infrastructure).sourceFiles;
  if (!manifest || manifest.version !== 1 || !digest(manifest.configBeforeSha256) || !digest(manifest.configAfterSha256)
    || !Number.isInteger(manifest.configBeforeMode) || manifest.configBeforeMode < 0 || manifest.configBeforeMode > 0o777
    || !Array.isArray(manifest.checks) || manifest.checks.length !== allowed.length
    || !Array.isArray(manifest.changes) || manifest.changes.length > allowed.length) throw conflict();
  const checks = new Map();
  for (const item of manifest.checks) {
    if (!item || !allowed.includes(item.path) || checks.has(item.path) || !digest(item.afterSha256)
      || !(digest(item.beforeSha256) || item.beforeSha256 === null && additions.has(item.path))) throw conflict();
    checks.set(item.path, item);
  }
  const seen = new Set();
  for (const item of manifest.changes) {
    if (!item || !allowed.includes(item.path) || seen.has(item.path) || !digest(item.afterSha256)
      || !(digest(item.beforeSha256) && Number.isInteger(item.beforeMode) && item.beforeMode >= 0 && item.beforeMode <= 0o777
        || item.beforeSha256 === null && item.beforeMode === null && additions.has(item.path))) throw conflict();
    const check = checks.get(item.path);
    if (!check || check.beforeSha256 !== item.beforeSha256 || check.afterSha256 !== item.afterSha256 || item.beforeSha256 === item.afterSha256) throw conflict();
    seen.add(item.path);
  }
  if (manifest.checks.some(item => item.beforeSha256 !== item.afterSha256 && !seen.has(item.path))) throw conflict();
  if ([...additions].some(path => !manifest.changes.some(item => item.path === path && item.beforeSha256 === null))) throw conflict();
  return valid;
}

function checked(ctx, fn) { try { return fn(); } catch { throw conflict(); } }

// Persists a private backup and candidate files before the caller stops the service.
// An incomplete backup remains in place and blocks another attempt for manual inspection.
export function prepareSharedUpgradeFiles({ root, plan } = {}) {
  return checked(null, () => {
    const ctx = context(root);
    if (!plan || !Array.isArray(plan.sourceChanges) || !Array.isArray(plan.sourceChecks)) throw conflict();
    const configBefore = ctx.read(configPath, false, true), configAfter = Buffer.from(JSON.stringify(plan.nextConfig) + '\n');
    const manifest = { version: 1, configBeforeSha256: plan.configBeforeSha256, configAfterSha256: hash(configAfter),
      configBeforeMode: ctx.mode(configPath), checks: plan.sourceChecks.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })),
      changes: plan.sourceChanges.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256, beforeMode: beforeSha256 === null ? null : ctx.mode(path) })) };
    validateManifest(manifest, plan.nextConfig);
    if (hash(configBefore) !== manifest.configBeforeSha256 || !unchangedConfig(configBefore, plan.nextConfig)) throw conflict();
    for (const item of manifest.checks) {
      const value = ctx.read(item.path, true);
      if ((value === null ? null : hash(value)) !== item.beforeSha256) throw conflict();
    }
    const before = [];
    for (let i = 0; i < manifest.changes.length; i++) {
      const item = manifest.changes[i], candidate = plan.sourceChanges[i].after;
      if (!Buffer.isBuffer(candidate) || hash(candidate) !== item.afterSha256) throw conflict();
      const data = ctx.read(item.path, true);
      if ((data === null ? null : hash(data)) !== item.beforeSha256) throw conflict();
      before.push(data);
    }
    const final = ctx.pathFor(backupPath), dir = ctx.pathFor(preparingPath);
    try { lstatSync(final); throw conflict(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirSync(dir, { mode: 0o700 }); ctx.syncDir(dirname(dir));
    ctx.writeNew(preparingPath + '/before-config', configBefore, 0o600);
    ctx.writeNew(preparingPath + '/after-config', configAfter, 0o600);
    for (let i = 0; i < manifest.changes.length; i++) {
      if (before[i] !== null) ctx.writeNew(preparingPath + '/before-' + i, before[i], 0o600);
      ctx.writeNew(preparingPath + '/after-' + i, plan.sourceChanges[i].after, 0o600);
    }
    ctx.writeNew(preparingPath + '/manifest.json', JSON.stringify(manifest) + '\n', 0o600);
    try { lstatSync(final); throw conflict(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(dir, final); ctx.syncDir(dirname(final));
    return openSharedUpgradeFiles({ root });
  });
}

// Only file operations are implemented here; the service must be stopped by a separate driver.
export function openSharedUpgradeFiles({ root } = {}) {
  return checked(null, () => {
    const ctx = context(root), directory = lstatSync(ctx.pathFor(backupPath));
    if (!directory.isDirectory() || directory.isSymbolicLink() || ctx.production && (directory.uid !== 0 || (directory.mode & 0o077))) throw conflict();
    const manifest = JSON.parse(ctx.read(backupPath + '/manifest.json', false, true).toString('utf8'));
    if (ctx.production && (manifest.configBeforeMode & 0o077 || manifest.changes?.some(item => item.beforeMode !== null && (item.beforeMode & 0o022)))) throw conflict();
    const load = () => {
      const beforeConfig = ctx.read(backupPath + '/before-config', false, true), afterConfig = ctx.read(backupPath + '/after-config', false, true);
      if (hash(beforeConfig) !== manifest.configBeforeSha256 || hash(afterConfig) !== manifest.configAfterSha256) throw conflict();
      const nextConfig = validateManifest(manifest, JSON.parse(afterConfig.toString('utf8')));
      if (!unchangedConfig(beforeConfig, nextConfig)) throw conflict();
      const before = [], after = [];
      for (let i = 0; i < manifest.changes.length; i++) {
        const item = manifest.changes[i];
        const b = item.beforeSha256 === null ? null : ctx.read(backupPath + '/before-' + i, false, true);
        const a = ctx.read(backupPath + '/after-' + i, false, true);
        if (b && hash(b) !== item.beforeSha256 || hash(a) !== item.afterSha256) throw conflict();
        before.push(b); after.push(a);
      }
      return { beforeConfig, afterConfig, before, after };
    };
    load();
    const currentHash = path => { const value = ctx.read(path, true, path === configPath); return value === null ? null : hash(value); };
    return {
      originalConfig() { return checked(ctx, () => JSON.parse(load().beforeConfig.toString('utf8'))); },
      verifyApplied() { return checked(ctx, () => {
        load(); return currentHash(configPath) === manifest.configAfterSha256
          && manifest.checks.every(item => currentHash(item.path) === item.afterSha256);
      }); },
      verifyRestored() { return checked(ctx, () => {
        load(); return currentHash(configPath) === manifest.configBeforeSha256
          && manifest.checks.every(item => currentHash(item.path) === item.beforeSha256);
      }); },
      replaceSource(index) { return checked(ctx, () => {
        ctx.stopped(); const data = load(), item = manifest.changes[index];
        if (!Number.isInteger(index) || !item) throw conflict();
        const current = currentHash(item.path); if (current === item.afterSha256) return;
        if (current !== item.beforeSha256) throw conflict();
        ctx.replace(item.path, data.after[index], 0o644);
      }); },
      replaceConfig() { return checked(ctx, () => {
        ctx.stopped(); const data = load();
        if (manifest.checks.some(item => currentHash(item.path) !== item.afterSha256)) throw conflict();
        const current = currentHash(configPath); if (current === manifest.configAfterSha256) return;
        if (current !== manifest.configBeforeSha256) throw conflict();
        ctx.replace(configPath, data.afterConfig, 0o600);
      }); },
      restore() { return checked(ctx, () => {
        ctx.stopped(); const data = load(), currentConfig = currentHash(configPath);
        if (![manifest.configBeforeSha256, manifest.configAfterSha256].includes(currentConfig)) throw conflict();
        if (manifest.checks.some(item => item.beforeSha256 === item.afterSha256 && currentHash(item.path) !== item.beforeSha256)) throw conflict();
        for (const item of manifest.changes) if (![item.beforeSha256, item.afterSha256].includes(currentHash(item.path))) throw conflict();
        for (let i = 0; i < manifest.changes.length; i++) {
          const item = manifest.changes[i], current = currentHash(item.path);
          if (current === item.beforeSha256) continue;
          if (current !== item.afterSha256) throw conflict();
          if (data.before[i] === null) ctx.remove(item.path); else ctx.replace(item.path, data.before[i], item.beforeMode);
        }
        const finalConfig = currentHash(configPath);
        if (finalConfig === manifest.configAfterSha256) ctx.replace(configPath, data.beforeConfig, manifest.configBeforeMode);
        else if (finalConfig !== manifest.configBeforeSha256) throw conflict();
        if (manifest.changes.some(item => currentHash(item.path) !== item.beforeSha256) || currentHash(configPath) !== manifest.configBeforeSha256) throw conflict();
      }); },
    };
  });
}
