import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, chownSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateHostedLaunchConfig, loadHostedTls, refreshHostedTls } from '../relay/hosted-launch.mjs';

test('a hosted service requires explicit binding, local paths and a bounded slot list', () => {
  const config = { version: 1, listenHost: '127.0.0.1', listenPort: 24444,
    databasePath: '/var/lib/rayneo-hosted/registry.sqlite', tlsKeyPath: '/etc/rayneo-hosted/tls.key',
    tlsCertPath: '/etc/rayneo-hosted/tls.crt', slots: [{ id: 'one' }] };
  assert.doesNotThrow(() => validateHostedLaunchConfig(config));
  for (const change of [{ listenHost: 'example.test' }, { listenPort: 0 }, { databasePath: 'relative' },
    { tlsKeyPath: '' }, { slots: [] }, { slots: Array(257).fill({}) }, { version: 2 }, { extra: true }]) {
    assert.throws(() => validateHostedLaunchConfig({ ...config, ...change }), { code: 'HOSTED_LAUNCH_INVALID' });
  }
});

test('renewed certificate links are accepted only when their private target belongs to the service owner',
  { skip: process.platform === 'win32' || process.getuid?.() !== 0 }, () => {
    const dir = mkdtempSync('/run/rayneo-tls-test-');
    const key = join(dir, 'key'), cert = join(dir, 'cert'), link = join(dir, 'current-key');
    try {
      writeFileSync(key, 'synthetic-key', { mode: 0o600 }); writeFileSync(cert, 'synthetic-cert'); symlinkSync(key, link);
      assert.equal(loadHostedTls({ tlsKeyPath: link, tlsCertPath: cert }).key.toString(), 'synthetic-key');
      const renewed = join(dir, 'renewed-key'); writeFileSync(renewed, 'renewed-synthetic-key', { mode: 0o600 });
      unlinkSync(link); symlinkSync(renewed, link);
      let loaded; refreshHostedTls({ setSecureContext(value) { loaded = value; } }, { tlsKeyPath: link, tlsCertPath: cert });
      assert.equal(loaded.key.toString(), 'renewed-synthetic-key');
      chownSync(renewed, 65534, 65534);
      assert.throws(() => loadHostedTls({ tlsKeyPath: link, tlsCertPath: cert }), { code: 'HOSTED_LAUNCH_INVALID' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
