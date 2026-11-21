import { createHash } from 'node:crypto';
import { createSharedInfrastructurePlan } from './shared-infrastructure.mjs';
import { validateSharedHostedLaunchConfig } from './shared-hosted-launch.mjs';

const fail = () => Object.assign(Error('SHARED_HOSTED_UPGRADE_INVALID'), { code: 'SHARED_HOSTED_UPGRADE_INVALID' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inviteDatabasePath = '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite';
const additions = new Set(['/opt/rayneo-paseo-shared/relay/invite-store.mjs', '/opt/rayneo-paseo-shared/relay/invite-admin.mjs']);
const validSource = value => Buffer.isBuffer(value) && value.length > 0 && value.length <= 1024 * 1024;

// Read-only planning only: a separate, verified executor must enforce every precondition.
export function createSharedHostedUpgradePlan({ currentConfigText, currentSources, candidateSources } = {}) {
  try {
    if (typeof currentConfigText !== 'string' || Buffer.byteLength(currentConfigText) > 16384
      || !currentSources || !candidateSources || Array.isArray(currentSources) || Array.isArray(candidateSources)) throw fail();
    const currentConfig = JSON.parse(currentConfigText);
    if (!currentConfig || Object.hasOwn(currentConfig, 'inviteDatabasePath')) throw fail();
    const nextConfig = validateSharedHostedLaunchConfig({ ...currentConfig, inviteDatabasePath });
    const paths = createSharedInfrastructurePlan(nextConfig.infrastructure).sourceFiles;
    if (Object.keys(currentSources).length !== paths.length || Object.keys(candidateSources).length !== paths.length
      || Object.keys(currentSources).some(path => !paths.includes(path)) || Object.keys(candidateSources).some(path => !paths.includes(path))) throw fail();
    const sourceChanges = [], sourceChecks = [];
    for (const path of paths) {
      const before = currentSources[path], after = candidateSources[path];
      if (!validSource(after) || (additions.has(path) ? before !== null : !validSource(before))) throw fail();
      const beforeSha256 = before === null ? null : hash(before), afterSha256 = hash(after);
      sourceChecks.push({ path, beforeSha256, afterSha256 });
      if (beforeSha256 !== afterSha256) sourceChanges.push({ path, beforeSha256, afterSha256, after: Buffer.from(after) });
    }
    return { nextConfig, configBeforeSha256: hash(Buffer.from(currentConfigText)), sourceChecks, sourceChanges };
  } catch { throw fail(); }
}
