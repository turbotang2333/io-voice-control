import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createSharedInfrastructurePlan } from './shared-infrastructure.mjs';
import { createSharedHostedUpgradePlan } from './shared-hosted-upgrade-plan.mjs';

const fail = () => Object.assign(Error('SHARED_HOSTED_UPGRADE_LOAD_FAILED'), { code: 'SHARED_HOSTED_UPGRADE_LOAD_FAILED' });
const configPath = '/etc/rayneo-paseo-shared/hosted.json';
const sourceRoot = '/opt/rayneo-paseo-shared/';
const liveBundle = '/run/rayneo-paseo-hosted-upgrade/bundle';

// Reads only the existing project files and a separately staged bundle; never starts a service.
export function loadSharedHostedUpgradePlan({ root, candidateRoot } = {}) {
  try {
    if (!isAbsolute(root ?? '') || !isAbsolute(candidateRoot ?? '')) throw fail();
    root = resolve(root); candidateRoot = resolve(candidateRoot);
    const production = root === '/';
    if (production ? process.platform !== 'linux' || process.geteuid?.() !== 0 || candidateRoot !== liveBundle : !candidateRoot.startsWith(root + sep)) throw fail();
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail();
    if (!production) { const marker = lstatSync(join(root, '.rayneo-upgrade-test-only')); if (!marker.isFile() || marker.isSymbolicLink()) throw fail(); }
    const safeRead = (full, missing, privateFile = false) => {
      if (!production && !full.startsWith(root + sep)) throw fail();
      let parent = dirname(full);
      while (true) {
        const s = lstatSync(parent);
        if (!s.isDirectory() || s.isSymbolicLink() || production && (s.uid !== 0 || (s.mode & 0o022))) throw fail();
        if (parent === root) break;
        const next = dirname(parent); if (next === parent) throw fail(); parent = next;
      }
      try {
        const stat = lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024
          || production && (stat.uid !== 0 || (stat.mode & (privateFile ? 0o077 : 0o022)))) throw fail();
        const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const actual = fstatSync(fd); if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw fail(); return readFileSync(fd); }
        finally { closeSync(fd); }
      } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    };
    const configBytes = safeRead(join(root, configPath.slice(1)), false, true);
    const currentConfigText = new TextDecoder('utf-8', { fatal: true }).decode(configBytes);
    const cfg = JSON.parse(currentConfigText), paths = createSharedInfrastructurePlan(cfg.infrastructure).sourceFiles;
    const currentSources = {}, candidateSources = {};
    for (const path of paths) {
      if (!path.startsWith(sourceRoot)) throw fail();
      const relative = path.slice(sourceRoot.length);
      currentSources[path] = safeRead(join(root, path.slice(1)), true);
      candidateSources[path] = safeRead(join(candidateRoot, relative), false);
    }
    return createSharedHostedUpgradePlan({ currentConfigText, currentSources, candidateSources });
  } catch { throw fail(); }
}
