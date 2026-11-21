import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as relay from '../relay/server.mjs';

test('the public relay entry refuses a loopback TCP target that may belong to another service', () => {
  assert.equal(typeof relay.validatePublicRelayConfig, 'function');
  assert.throws(() => relay.validatePublicRelayConfig({ version: 1, listenPort: 24443, targetPort: 28001 }),
    { code: 'RELAY_ISOLATION_REQUIRED' });
  assert.throws(() => relay.validatePublicRelayConfig({ version: 1, listenPort: 24443, targetPort: 0 }),
    { code: 'RELAY_CONFIG_INVALID' });
});

test('the real relay entry listens locally and closes requests when its private socket is absent', async () => {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'rayneo-relay-cli-'));
  const config = join(dir, 'relay.json');
  writeFileSync(config, JSON.stringify({ version: 2, listenPort: port, listenHost: '127.0.0.1',
    targetSocket: '/var/lib/rayneo-relay/12345678-1234-1234-1234-123456789abc/tunnel/relay.sock' }));
  const child = spawn(process.execPath, ['relay/server.mjs', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('relay did not start')), 5000);
      child.stdout.on('data', data => { if (data.toString().includes('RELAY_READY')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error('relay exited: ' + code)); });
    });
    const data = await new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }); let received = '';
      socket.on('data', chunk => { received += chunk; }); socket.on('error', reject); socket.on('end', () => resolve(received));
    });
    assert.equal(data, '');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isolated relay configuration accepts only one dedicated socket and bounded limits', () => {
  const good = { version: 2, listenPort: 24443,
    targetSocket: '/var/lib/rayneo-relay/12345678-1234-1234-1234-123456789abc/tunnel/relay.sock',
    maxConnections: 128, maxPerIp: 16, idleTimeoutMs: 300000, connectTimeoutMs: 10000 };
  assert.doesNotThrow(() => relay.validateIsolatedRelayConfig(good));
  for (const change of [
    { targetPort: 28001 }, { targetSocket: '/tmp/relay.sock' }, { targetSocket: good.targetSocket + '/../relay.sock' },
    { listenPort: 0 }, { maxConnections: 0 }, { maxPerIp: 4097 }, { idleTimeoutMs: 1 }, { connectTimeoutMs: 1 },
    { unexpected: true }, { version: 1 },
  ]) assert.throws(() => relay.validateIsolatedRelayConfig({ ...good, ...change }), { code: 'RELAY_CONFIG_INVALID' });
  assert.doesNotThrow(() => relay.validatePublicRelayConfig(good));
  assert.doesNotThrow(() => relay.validateIsolatedRelayConfig({ ...good, listenHost: '127.0.0.1' }));
  assert.throws(() => relay.validateIsolatedRelayConfig({ ...good, listenHost: '192.0.2.1' }), { code: 'RELAY_CONFIG_INVALID' });
});
