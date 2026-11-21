import { readFileSync } from 'node:fs';

const fail = () => Object.assign(Error('SHARED_UPGRADE_GUARD_INVALID'), { code: 'SHARED_UPGRADE_GUARD_INVALID' });
const guardPath = '/opt/rayneo-paseo-shared/relay/shared-hosted-upgrade-guard.mjs';
const dropInPath = '/etc/systemd/system/rayneo-shared-hosted.service.d/upgrade-safety.conf';
const lockPath = '/var/lib/rayneo-paseo-shared-hosted/upgrade-startup-lock.sqlite';

// Read-only preparation. A separate installer must verify ownership and install these files safely.
export function createSharedHostedGuardPlan({ nodePath } = {}) {
  if (typeof nodePath !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(nodePath) || nodePath.includes('..')) throw fail();
  return { guardPath, dropInPath, lockPath, guardSource: readFileSync(new URL('./shared-hosted-upgrade-guard.mjs', import.meta.url)),
    dropIn: `[Service]\nExecStartPre=${nodePath} ${guardPath} --verify-live\n` };
}
