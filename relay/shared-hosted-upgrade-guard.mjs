import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Standalone on purpose: startup must not import files that are being replaced.
const backup = '/var/lib/rayneo-paseo-shared-hosted/upgrade-backup';
const config = '/etc/rayneo-paseo-shared/hosted.json';
const sources = ['relay/shared-router-launch.mjs', 'relay/shared-router.mjs', 'relay/shared-client-hello.mjs', 'relay/shared-configuration.mjs',
  'relay/shared-hosted-launch.mjs', 'relay/shared-hosted-service.mjs', 'relay/shared-hosted-runtime.mjs', 'relay/shared-hosted-allocator.mjs',
  'relay/invite-store.mjs', 'relay/invite-admin.mjs', 'relay/shared-account-driver.mjs', 'relay/shared-infrastructure.mjs',
  'relay/hosted-allocator.mjs', 'relay/hosted-server.mjs', 'relay/unix-provision.mjs', 'secure-link/config.mjs', 'distribution/hosted-enrollment.mjs']
  .map(path => '/opt/rayneo-paseo-shared/' + path);
const additions = new Set(['/opt/rayneo-paseo-shared/relay/invite-store.mjs', '/opt/rayneo-paseo-shared/relay/invite-admin.mjs']);
const hash = data => createHash('sha256').update(data).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const upgradeGuardSourcePaths = () => [...sources];

function checkUpgradeFiles({ root } = {}) {
  try {
    if (!isAbsolute(root ?? '')) return false;
    root = resolve(root); const production = root === '/';
    if (production && (process.platform !== 'linux' || process.geteuid?.() !== 0)) return false;
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    if (!production) { const marker = lstatSync(join(root, '.rayneo-upgrade-test-only')); if (!marker.isFile() || marker.isSymbolicLink()) return false; }
    const pathFor = path => {
      if (!path.startsWith('/') || path.includes('..') || path.includes('\\')) throw Error();
      const full = join(root, path.slice(1));
      if (!production && !full.startsWith(root + sep)) throw Error();
      let parent = dirname(full);
      while (true) {
        const s = lstatSync(parent);
        if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) throw Error();
        if (parent === root) break;
        const next = dirname(parent); if (next === parent) throw Error(); parent = next;
      }
      return full;
    };
    const read = (path, missing = false, privateFile = false) => {
      try {
        const full = pathFor(path), s = lstatSync(full);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 1024 * 1024
          || production && (s.uid !== 0 || (s.mode & (privateFile ? 0o077 : 0o022)))) throw Error();
        const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const actual = fstatSync(fd); if (actual.ino !== s.ino || actual.dev !== s.dev) throw Error(); return readFileSync(fd); }
        finally { closeSync(fd); }
      } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    };
    let directory;
    try { directory = lstatSync(pathFor(backup)); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    if (!directory.isDirectory() || directory.isSymbolicLink() || production && (directory.uid !== 0 || (directory.mode & 0o077))) return false;
    const manifest = JSON.parse(read(backup + '/manifest.json', false, true).toString('utf8'));
    if (manifest.version !== 1 || !digest(manifest.configBeforeSha256) || !digest(manifest.configAfterSha256)
      || !Array.isArray(manifest.checks) || manifest.checks.length !== sources.length || !Array.isArray(manifest.changes)) return false;
    const checks = new Map();
    for (const item of manifest.checks) {
      if (!item || !sources.includes(item.path) || checks.has(item.path) || !digest(item.afterSha256)
        || !(digest(item.beforeSha256) || item.beforeSha256 === null && additions.has(item.path))) return false;
      checks.set(item.path, item);
    }
    const changes = new Set();
    for (let i = 0; i < manifest.changes.length; i++) {
      const item = manifest.changes[i], expected = checks.get(item?.path);
      if (!expected || changes.has(item.path) || item.beforeSha256 !== expected.beforeSha256 || item.afterSha256 !== expected.afterSha256
        || item.beforeSha256 === item.afterSha256) return false;
      changes.add(item.path);
      if (item.beforeSha256 !== null && hash(read(backup + '/before-' + i, false, true)) !== item.beforeSha256) return false;
      if (hash(read(backup + '/after-' + i, false, true)) !== item.afterSha256) return false;
    }
    if ([...additions].some(path => !changes.has(path) || checks.get(path).beforeSha256 !== null)
      || manifest.checks.some(item => item.beforeSha256 !== item.afterSha256 && !changes.has(item.path))) return false;
    if (hash(read(backup + '/before-config', false, true)) !== manifest.configBeforeSha256
      || hash(read(backup + '/after-config', false, true)) !== manifest.configAfterSha256) return false;
    const currentConfig = hash(read(config, false, true));
    let before = currentConfig === manifest.configBeforeSha256, after = currentConfig === manifest.configAfterSha256;
    for (const item of manifest.checks) {
      const bytes = read(item.path, true), actual = bytes === null ? null : hash(bytes);
      before &&= actual === item.beforeSha256; after &&= actual === item.afterSha256;
    }
    return before || after;
  } catch { return false; }
}

export function checkUpgradeStartup({ root } = {}) {
  let db;
  try {
    if (!isAbsolute(root ?? '')) return false; root = resolve(root); const production = root === '/';
    if (production && (process.platform !== 'linux' || process.geteuid?.() !== 0)) return false;
    const base = lstatSync(root); if (!base.isDirectory() || base.isSymbolicLink()) return false;
    if (!production) { const marker = lstatSync(join(root, '.rayneo-upgrade-test-only')); if (!marker.isFile() || marker.isSymbolicLink()) return false; }
    const full = join(root, 'var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite');
    if (!production && !full.startsWith(root + sep)) return false;
    let parent = dirname(full);
    while (true) {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) return false;
      if (parent === root) break; const next = dirname(parent); if (next === parent) return false; parent = next;
    }
    const s = lstatSync(full);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || production && (s.uid !== 0 || (s.mode & 0o077))) return false;
    db = new DatabaseSync(full, { timeout: 0 }); db.exec('BEGIN IMMEDIATE');
    return checkUpgradeFiles({ root });
  } catch { return false; }
  finally { if (db) { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--verify-live' || !checkUpgradeStartup({ root: '/' })) {
    process.stderr.write('SHARED_UPGRADE_STARTUP_BLOCKED\n'); process.exitCode = 1;
  }
}
