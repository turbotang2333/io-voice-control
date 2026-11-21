import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSharedHostedConfig, installSharedHostedStack } from '../relay/shared-wizard.mjs';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const answers = { publicBaseUrl: 'https://relay.example.test:24443', sshHost: 'ssh.example.test', sshPort: 2222, enrollmentPort: 24445,
  tlsKeyPath: '/etc/ssl/private/test.key', tlsCertPath: '/etc/ssl/test.crt', maxAllocations: 1000 };

test('wizard turns operator choices into consistent shared service settings', () => {
  const config = prepareSharedHostedConfig({ answers, hostKey: key, nodePath: '/usr/bin/node' });
  assert.equal(config.shared.relay.hostKey, key);
  assert.equal(config.infrastructure.suffix, 'relay.example.test');
  assert.equal(config.infrastructure.publicPort, 24443);
  assert.equal(config.infrastructure.sshPort, 2222);
  assert.equal(config.listenPort, 24445);
  assert.throws(() => prepareSharedHostedConfig({ answers: { ...answers, enrollmentPort: 2222 }, hostKey: key, nodePath: '/usr/bin/node' }));
});

test('wizard resumes an already verified shared installation without starting it again', async () => {
  const calls = [];
  const result = await installSharedHostedStack({ config: prepareSharedHostedConfig({ answers, hostKey: key, nodePath: '/usr/bin/node' }),
    inspectInfrastructure: async () => true,
    installInfrastructure: async () => { calls.push('infrastructure'); },
    inspectHosted: async () => false,
    installHosted: async () => { calls.push('hosted'); } });
  assert.deepEqual(calls, ['hosted']);
  assert.deepEqual(result, { installed: true, encryption: 'unverified' });
});
