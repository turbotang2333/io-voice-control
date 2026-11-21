import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { relayArguments } from '../bridge/supervisor.mjs';
import { connectorRelayArguments } from '../experiments/codex-connector/wireless-check.mjs';
import { connectorMaintenancePlan } from '../experiments/codex-connector/supervisor.mjs';

test('a trial uses its own SSH configuration and allocated loopback ports without changing daily defaults', () => {
  const config = resolve('synthetic-private/ssh-config');
  const paseo = relayArguments({ sshHost: 'trial-host', sshConfigPath: config, remotePort: 28001 }, 7468);
  assert.deepEqual(paseo.slice(0, 2), ['-F', config]);
  assert.ok(paseo.includes('127.0.0.1:28001:127.0.0.1:7468'));
  const profile = { host: '127.0.0.1', port: 19469, token: 'a'.repeat(64), navigation: true,
    pfxPath: resolve('synthetic-private/server.p12'), password: 'synthetic-password' };
  const wireless = { endpoint: 'https://example.test/trial/codex', sshHost: 'trial-host', sshConfigPath: config,
    localPort: 19469, remoteLoopbackPort: 28002, configPath: resolve('synthetic-private/connector.json') };
  const args = connectorRelayArguments(profile, wireless);
  assert.deepEqual(args.slice(0, 2), ['-F', config]);
  assert.ok(args.includes('127.0.0.1:28002:127.0.0.1:19469'));
  assert.equal(connectorMaintenancePlan(profile, wireless, wireless.configPath).port, 19469);
  assert.ok(connectorRelayArguments(profile, { sshHost: 'daily-host' }).includes('127.0.0.1:17469:127.0.0.1:19469'));
  for (const bad of ['relative-file', 'C:\\bad\nfile']) assert.throws(() => relayArguments({ sshHost: 'trial-host', sshConfigPath: bad, remotePort: 28001 }, 7468));
});
