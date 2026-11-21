import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSharedHostedLaunchConfig, createSharedHostedLaunchPlan, installSharedHostedService } from '../relay/shared-hosted-launch.mjs';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const config = { version: 1, listenHost: '127.0.0.1', listenPort: 28445,
  databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite', inviteDatabasePath: '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite', tlsKeyPath: '/etc/example/key.pem', tlsCertPath: '/etc/example/cert.pem', maxAllocations: 5000,
  shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key } },
  infrastructure: { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node', listenHost: '127.0.0.1' } };

test('launcher requires distinct ports, matching shared infrastructure, and local file paths', () => {
  assert.deepEqual(validateSharedHostedLaunchConfig(config), config);
  for (const change of [
    { listenPort: 2222 }, { listenPort: 24443 }, { tlsKeyPath: '../key' }, { maxAllocations: 0 }, { inviteDatabasePath: undefined },
    { shared: { ...config.shared, publicBaseUrl: 'https://other.example.test:24443' } },
    { infrastructure: { ...config.infrastructure, sshPort: 2223 } }, { unknown: true }
  ]) assert.throws(() => validateSharedHostedLaunchConfig({ ...config, ...change }));
});

test('hosted startup installation checks first and preserves uncertain state on failure', async () => {
  const calls = [];
  const driver = Object.fromEntries(['preflight', 'createFiles', 'verify', 'start', 'check', 'rollback']
    .map(name => [name, async () => { calls.push(name); if (name === 'check') return true; }]));
  assert.deepEqual(await installSharedHostedService(config, driver), { installed: true, encryption: 'unverified' });
  assert.deepEqual(calls, ['preflight', 'createFiles', 'verify', 'start', 'check']);
  driver.start = async () => { throw Error('failed'); }; driver.rollback = async () => { throw Error('uncertain'); };
  await assert.rejects(installSharedHostedService(config, driver), { code: 'SHARED_HOSTED_INSTALL_UNCERTAIN' });
});

test('startup file contains only operator configuration and a separate service', () => {
  const plan = createSharedHostedLaunchPlan(config);
  assert.deepEqual(JSON.parse(plan.configFile), config);
  assert.match(plan.serviceUnit, /^ExecStart=\/usr\/bin\/node \/opt\/rayneo-paseo-shared\/relay\/shared-hosted-launch.mjs --config /m);
  assert.match(plan.serviceUnit, /^After=rayneo-shared-ssh.service rayneo-shared-router.service$/m);
});
