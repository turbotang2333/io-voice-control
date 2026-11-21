import { resolve } from 'node:path';
import { openSharedUpgradeFiles, prepareSharedUpgradeFiles } from './shared-hosted-upgrade-files.mjs';
import { checkUpgradeStartup } from './shared-hosted-upgrade-guard.mjs';
import { createSharedHostedSystemdService } from './shared-hosted-systemd-service.mjs';
import { acquireSharedUpgradeStartupLock } from './shared-hosted-upgrade-lock.mjs';

const fail = code => Object.assign(Error(code), { code });
const validService = (service, names) => service && names.every(name => typeof service[name] === 'function');

export function createSharedHostedUpgradeDriver({ root, service } = {}) {
  if (!root) throw fail('SHARED_HOSTED_UPGRADE_DRIVER_INVALID');
  if (resolve(root) === '/') {
    if (service !== undefined || process.platform !== 'linux' || process.geteuid?.() !== 0) throw fail('SHARED_HOSTED_UPGRADE_DRIVER_INVALID');
    service = createSharedHostedSystemdService();
  }
  if (!validService(service, ['guardReady', 'canProbeEnrollment', 'isActive', 'stop', 'start', 'verifyNew', 'verifyOld'])) throw fail('SHARED_HOSTED_UPGRADE_DRIVER_INVALID');
  let files, startupLock;
  const acquire = () => { if (!startupLock) startupLock = acquireSharedUpgradeStartupLock({ root }); };
  const release = () => { if (startupLock) { const lock = startupLock; startupLock = undefined; lock.release(); } };
  const requireGuard = async config => {
    if (await service.guardReady(config.infrastructure.nodePath) !== true) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN');
  };
  return {
    async preflight(plan) {
      if (await service.guardReady(plan.nextConfig.infrastructure.nodePath) !== true
        || await service.isActive() !== true || await service.verifyOld(plan.nextConfig) !== true
        || await service.canProbeEnrollment(plan.nextConfig) !== true) throw fail('SHARED_HOSTED_UPGRADE_INACTIVE');
    },
    async backup(plan) { files = prepareSharedUpgradeFiles({ root, plan }); if (!checkUpgradeStartup({ root })) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); return { verified: true }; },
    async stop(plan) { await requireGuard(plan.nextConfig); acquire(); await service.stop(); },
    async replaceSources(plan) { if (!startupLock) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); for (let i = 0; i < plan.sourceChanges.length; i++) { await requireGuard(plan.nextConfig); files.replaceSource(i); } },
    async replaceConfig(plan) { if (!startupLock) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); await requireGuard(plan.nextConfig); files.replaceConfig(); },
    async start(plan) {
      await requireGuard(plan.nextConfig); if (!startupLock || !files.verifyApplied()) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN');
      release(); if (!checkUpgradeStartup({ root })) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); await service.start();
    },
    async verify(plan) { return await service.verifyNew(plan.nextConfig) === true && files.verifyApplied(); },
    async rollback() {
      const config = files.originalConfig();
      try { await requireGuard(config); acquire(); await service.stop(); files.restore(); if (!files.verifyRestored()) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); }
      finally { release(); }
      await requireGuard(config); if (!checkUpgradeStartup({ root })) throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); await service.start();
    },
    async verifyRollback() { return await service.verifyOld(files.originalConfig()) === true && files.verifyRestored(); },
  };
}

export async function recoverSharedHostedUpgrade({ root, service } = {}) {
  if (!root) throw fail('SHARED_HOSTED_UPGRADE_DRIVER_INVALID');
  if (resolve(root) === '/') {
    if (service !== undefined || process.platform !== 'linux' || process.geteuid?.() !== 0) throw fail('SHARED_HOSTED_UPGRADE_DRIVER_INVALID');
    service = createSharedHostedSystemdService();
  }
  if (!validService(service, ['guardReady', 'stop', 'start', 'verifyOld'])) throw fail('SHARED_HOSTED_UPGRADE_DRIVER_INVALID');
  try {
    const files = openSharedUpgradeFiles({ root });
    const config = files.originalConfig();
    if (await service.guardReady(config.infrastructure.nodePath) !== true) throw Error('startup guard unavailable');
    const startupLock = acquireSharedUpgradeStartupLock({ root });
    try { await service.stop(); files.restore(); if (!files.verifyRestored()) throw Error('unsafe recovery'); }
    finally { startupLock.release(); }
    if (await service.guardReady(config.infrastructure.nodePath) !== true || !checkUpgradeStartup({ root })) throw Error('unsafe recovery');
    await service.start();
    if (await service.verifyOld(files.originalConfig()) !== true || !files.verifyRestored()) throw Error('unverified recovery');
    return { recovered: true };
  } catch { throw fail('SHARED_HOSTED_UPGRADE_UNCERTAIN'); }
}
