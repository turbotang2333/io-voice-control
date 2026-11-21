import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedInfrastructurePlan } from '../relay/shared-infrastructure.mjs';
import { createSharedHostedUpgradePlan } from '../relay/shared-hosted-upgrade-plan.mjs';
import { upgradeGuardSourcePaths } from '../relay/shared-hosted-upgrade-guard.mjs';
import { createSharedHostedGuardPlan } from '../relay/shared-hosted-upgrade-guard-plan.mjs';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const config = { version: 1, listenHost: '127.0.0.1', listenPort: 28445,
  databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite', tlsKeyPath: '/etc/example/key.pem', tlsCertPath: '/etc/example/cert.pem', maxAllocations: 5000,
  shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key } },
  infrastructure: { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node', listenHost: '127.0.0.1' } };
const additions = new Set(['/opt/rayneo-paseo-shared/relay/invite-store.mjs', '/opt/rayneo-paseo-shared/relay/invite-admin.mjs']);
function fixture() {
  const files = createSharedInfrastructurePlan(config.infrastructure).sourceFiles;
  const current = Object.fromEntries(files.map(path => [path, additions.has(path) ? null : Buffer.from('old:' + path)]));
  const candidate = Object.fromEntries(files.map(path => [path, additions.has(path) ? Buffer.from('new:' + path) : current[path]]));
  candidate['/opt/rayneo-paseo-shared/relay/shared-hosted-runtime.mjs'] = Buffer.from('new-runtime');
  return { current, candidate };
}

test('the standalone startup guard covers every source used by the relay', () => {
  assert.deepEqual(upgradeGuardSourcePaths(), createSharedInfrastructurePlan(config.infrastructure).sourceFiles);
});

test('guard installation uses a separate service override and keeps log settings untouched', () => {
  const plan = createSharedHostedGuardPlan({ nodePath: '/usr/bin/node' });
  assert.equal(plan.guardPath, '/opt/rayneo-paseo-shared/relay/shared-hosted-upgrade-guard.mjs');
  assert.equal(plan.dropInPath, '/etc/systemd/system/rayneo-shared-hosted.service.d/upgrade-safety.conf');
  assert.match(plan.dropIn, /^ExecStartPre=\/usr\/bin\/node \/opt\/rayneo-paseo-shared\/relay\/shared-hosted-upgrade-guard\.mjs --verify-live$/m);
  assert.doesNotMatch(plan.dropIn, /LogNamespace|ExecStart=/);
  assert.throws(() => createSharedHostedGuardPlan({ nodePath: '/usr/bin/node\nExecStart=/bin/sh' }), { code: 'SHARED_UPGRADE_GUARD_INVALID' });
});

test('upgrade plan preserves the registry and existing configuration and records exact file preconditions', () => {
  const { current, candidate } = fixture(), original = structuredClone(config);
  const plan = createSharedHostedUpgradePlan({ currentConfigText: JSON.stringify(config, null, 2) + '\n', currentSources: current, candidateSources: candidate });
  assert.deepEqual(config, original);
  assert.equal(plan.nextConfig.databasePath, config.databasePath);
  assert.equal(plan.nextConfig.inviteDatabasePath, '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite');
  assert.deepEqual({ ...plan.nextConfig, inviteDatabasePath: undefined }, { ...config, inviteDatabasePath: undefined });
  assert.equal(plan.sourceChanges.length, 3);
  assert.match(plan.configBeforeSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.sourceChanges.filter(x => x.beforeSha256 === null).length, 2);
  assert.ok(plan.sourceChanges.every(x => /^[a-f0-9]{64}$/.test(x.afterSha256)));
  assert.ok(plan.sourceChanges.every(x => !x.path.includes('/var/lib/') && !x.path.includes('/etc/systemd/')));
});

test('upgrade plan refuses missing inputs, pre-existing invitation files, and modified scope', () => {
  for (const scenario of ['missing-old', 'missing-candidate', 'already-installed', 'unexpected-file', 'already-configured']) {
    const { current, candidate } = fixture(), input = { currentConfigText: JSON.stringify(config), currentSources: current, candidateSources: candidate };
    if (scenario === 'missing-old') current['/opt/rayneo-paseo-shared/relay/hosted-server.mjs'] = null;
    if (scenario === 'missing-candidate') delete candidate['/opt/rayneo-paseo-shared/relay/hosted-server.mjs'];
    if (scenario === 'already-installed') current['/opt/rayneo-paseo-shared/relay/invite-store.mjs'] = Buffer.from('existing');
    if (scenario === 'unexpected-file') candidate['/etc/systemd/journald.conf'] = Buffer.from('changed');
    if (scenario === 'already-configured') input.currentConfigText = JSON.stringify({ ...config, inviteDatabasePath: '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite' });
    assert.throws(() => createSharedHostedUpgradePlan(input), { code: 'SHARED_HOSTED_UPGRADE_INVALID' }, scenario);
  }
});
