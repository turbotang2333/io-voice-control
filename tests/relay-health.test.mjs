import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function fixture(options = {}) {
  const { createRelayHealthMonitor } = await import('../bridge/relay-health.mjs');
  let local = 'ready', remote = 'ready', restarts = 0, now = 0;
  const states = [];
  const monitor = createRelayHealthMonitor({ probeLocal: async () => local, probePublic: async () => remote,
    restartRelay: async () => { restarts++; return true; }, now: () => now, failureThreshold: 3,
    cooldownMs: 120000, maxRecoveryAttempts: 2, onChange: value => states.push(value), ...options });
  return { monitor, states, setLocal: v => { local = v; }, setRemote: v => { remote = v; },
    advance: v => { now += v; }, restarts: () => restarts };
}

test('recovers a live but unusable relay after repeated end-to-end failures, never sends messages', async () => {
  const f = await fixture();
  assert.equal((await f.monitor.check()).state, 'ready');
  f.setRemote('unreachable');
  await f.monitor.check(); await f.monitor.check();
  assert.equal(f.restarts(), 0);
  assert.equal((await f.monitor.check()).state, 'relay_recovering');
  assert.equal(f.restarts(), 1);
  f.setRemote('ready');
  assert.equal((await f.monitor.check()).state, 'ready');
  await f.monitor.stop();
});

test('bounds retries for a permanently occupied port and keeps checking for recovery', async () => {
  const f = await fixture(); f.setRemote('unreachable');
  for (let i = 0; i < 12; i++) await f.monitor.check();
  assert.equal(f.restarts(), 1);
  f.advance(120000); await f.monitor.check();
  assert.equal(f.restarts(), 2);
  f.advance(120000);
  assert.equal((await f.monitor.check()).state, 'relay_unavailable');
  assert.equal(f.restarts(), 2);
  // One lucky response must not reset the retry budget.
  f.setRemote('ready'); await f.monitor.check(); f.setRemote('unreachable');
  for (let i = 0; i < 4; i++) await f.monitor.check();
  assert.equal(f.restarts(), 2);
  f.setRemote('ready'); await f.monitor.check(); await f.monitor.check();
  f.setRemote('unreachable'); f.advance(120000);
  for (let i = 0; i < 3; i++) await f.monitor.check();
  assert.equal(f.restarts(), 3);
  await f.monitor.stop();
});

test('does not restart forwarding for Paseo reconnects, bad credentials, or a local bridge outage', async () => {
  const f = await fixture();
  for (const [local, remote, expected] of [['reconnecting', 'reconnecting', 'backend_reconnecting'],
    ['ready', 'rejected', 'configuration_error'], ['unreachable', 'unreachable', 'local_unavailable']]) {
    f.setLocal(local); f.setRemote(remote);
    for (let i = 0; i < 4; i++) assert.equal((await f.monitor.check()).state, expected);
  }
  assert.equal(f.restarts(), 0);
  await f.monitor.stop();
});

test('resumes slow relay recovery after exhausting rapid retries instead of staying offline forever', async () => {
  const f = await fixture(); f.setRemote('unreachable');
  for (let i = 0; i < 3; i++) await f.monitor.check();
  assert.equal(f.restarts(), 1);
  f.advance(120000); await f.monitor.check();
  assert.equal(f.restarts(), 2);
  f.advance(599999); await f.monitor.check();
  assert.equal(f.restarts(), 2, 'exhausted retries must wait ten minutes, without a restart storm');
  f.advance(1); await f.monitor.check();
  assert.equal(f.restarts(), 3, 'a temporary outage must not disable recovery permanently');
  f.advance(120000); await f.monitor.check();
  assert.equal(f.restarts(), 3, 'later retries must retain the slower cadence');
  f.advance(480000); await f.monitor.check();
  assert.equal(f.restarts(), 4);
  f.setRemote('ready'); await f.monitor.check();
  assert.equal((await f.monitor.check()).recoveryAttempts, 0);
  await f.monitor.stop();
});

test('computer network outages do not spend the retry budget needed when the network returns', async () => {
  const f = await fixture(); f.setRemote('network_unavailable');
  for (let i = 0; i < 20; i++) {
    assert.equal((await f.monitor.check()).state, 'network_unavailable'); f.advance(30000);
  }
  assert.equal(f.restarts(), 0);
  f.setRemote('unreachable');
  for (let i = 0; i < 3; i++) await f.monitor.check();
  assert.equal(f.restarts(), 1);
  await f.monitor.stop();
});

test('an exited relay recovers on the first reachable health failure while a live relay keeps its grace period', async () => {
  const f = await fixture({ getRelayState: () => ({ running: false, lastExitReason: 'connection_lost' }) });
  f.setRemote('unreachable');
  await f.monitor.check();
  assert.equal(f.restarts(), 1);
  await f.monitor.check(); await f.monitor.check();
  assert.equal(f.restarts(), 1, 'an exited child must still respect restart cooldown');
  f.setRemote('network_unavailable'); f.advance(120000);
  await f.monitor.check();
  assert.equal(f.restarts(), 1, 'a dead relay does not justify retries without a reachable public endpoint');
  await f.monitor.stop();
});

test('SSH authentication and host identity failures stop automatic recovery without weakening checks', async () => {
  for (const lastExitReason of ['authentication_failed', 'host_key_failed', 'executable_missing', 'permission_denied']) {
    const f = await fixture({ getRelayState: () => ({ running: false, lastExitReason }) });
    f.setRemote('unreachable');
    for (let i = 0; i < 5; i++) {
      assert.equal((await f.monitor.check()).state, 'configuration_error');
      f.advance(600000);
    }
    assert.equal(f.restarts(), 0);
    await f.monitor.stop();
  }
});

test('each health check refreshes its timestamp and reports cooldown without logging unchanged states repeatedly', async () => {
  const checks = [];
  const f = await fixture({ onCheck: value => checks.push(value), getRelayState: () => ({ running: false }) });
  await f.monitor.check(); f.advance(1000); await f.monitor.check();
  assert.equal(checks.length, 2);
  assert.equal(checks[1].checkedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(f.states.length, 1);
  f.setRemote('unreachable'); await f.monitor.check();
  const waiting = await f.monitor.check();
  assert.equal(waiting.nextRecoveryAt, '1970-01-01T00:02:01.000Z');
  await f.monitor.stop();
});

test('serializes overlapping checks, survives probe exceptions and cannot restart after stopping', async () => {
  let release, calls = 0, restarts = 0;
  const { createRelayHealthMonitor } = await import('../bridge/relay-health.mjs');
  const monitor = createRelayHealthMonitor({ probeLocal: () => { calls++; return new Promise(r => { release = r; }); },
    probePublic: async () => { throw Error('private-url-must-not-escape'); }, restartRelay: async () => { restarts++; }, failureThreshold: 1 });
  const a = monitor.check(), b = monitor.check();
  assert.equal(calls, 1);
  const stopping = monitor.stop(); release('ready');
  await Promise.all([a, b, stopping]);
  assert.equal(restarts, 0);
  assert.equal((await monitor.check()).state, 'stopped');
});

test('health probe verifies TLS and authentication, accepts backend reconnects and never posts chat', async t => {
  const { probeBridgeHealth } = await import('../bridge/relay-health.mjs');
  const root = mkdtempSync(join(homedir(), '.local/state/rayneo-paseo/test-relay-tls-'));
  const pfx = join(root, 'fixture.p12'), cert = join(root, 'fixture.pem');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('keytool', ['-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1',
    '-dname', 'CN=localhost', '-ext', 'SAN=ip:127.0.0.1,dns:localhost', '-storetype', 'PKCS12',
    '-keystore', pfx, '-storepass', 'test-only-password', '-noprompt'], { stdio: 'pipe', windowsHide: true });
  execFileSync('keytool', ['-exportcert', '-rfc', '-alias', 'fixture', '-keystore', pfx, '-storepass', 'test-only-password', '-file', cert],
    { stdio: 'pipe', windowsHide: true });
  let mode = 'ready', requests = 0, rejectedClosed = false;
  const server = createServer({ pfx: readFileSync(pfx), passphrase: 'test-only-password' }, (req, res) => {
    requests++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/healthz');
    if (mode === 'rejected-hang') {
      req.socket.once('close', () => { rejectedClosed = true; }); res.writeHead(401); res.flushHeaders(); return;
    }
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end('{}'); return; }
    if (mode === 'oversize') { res.end('x'.repeat(4096)); return; }
    const ready = mode === 'ready'; res.writeHead(ready ? 200 : 503).end(JSON.stringify({ ok: ready, status: mode }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const options = { url: `https://127.0.0.1:${server.address().port}/healthz`, token: 'fixture-token', ca: readFileSync(cert) };
  assert.equal(await probeBridgeHealth(options), 'ready');
  assert.equal(await probeBridgeHealth({ ...options, token: 'wrong' }), 'rejected');
  mode = 'reconnecting'; assert.equal(await probeBridgeHealth(options), 'reconnecting');
  mode = 'oversize'; assert.equal(await probeBridgeHealth(options), 'unreachable');
  assert.equal(await probeBridgeHealth({ ...options, ca: undefined }), 'rejected');
  assert.equal(requests, 4);
  mode = 'rejected-hang';
  assert.equal(await probeBridgeHealth(options), 'rejected');
  const deadline = Date.now() + 500;
  while (!rejectedClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(rejectedClosed, true, 'rejected responses must not leave sockets open beyond the probe');
});

test('health probe aborts a stalled TLS handshake at its absolute deadline', async t => {
  const { probeBridgeHealth } = await import('../bridge/relay-health.mjs');
  const sockets = new Set();
  const server = createTcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const started = Date.now();
  assert.equal(await probeBridgeHealth({ url: `https://127.0.0.1:${server.address().port}/healthz`, token: 'fixture', timeoutMs: 100 }), 'network_unavailable');
  assert.ok(Date.now() - started < 1500);
});
