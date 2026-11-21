import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tlsFixture, listen, close } from './helpers/tls-fixture.mjs';
import { createOpaqueRelay } from '../relay/server.mjs';
import { createDesktopGateway } from '../secure-link/gateway.mjs';

const run = promisify(execFile), identity = tlsFixture('encrypted-transport');
const other = tlsFixture('encrypted-transport-attacker');
const classes = join(identity.directory, 'classes');
execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes,
  'android-addon/src/cn/yilu/rayneopaseo/PinnedTls.java', 'android-addon/tests/PinnedTlsTest.java'], { stdio: 'pipe' });
async function phone(url, pin = identity.certificateSha256, mode = 'accept') {
  return (await run('java', ['-cp', classes, 'cn.yilu.rayneopaseo.PinnedTlsTest', url, pin, 'synthetic-private-token', mode], { timeout: 10000 })).stdout;
}

test('phone verifies the pinned desktop certificate when connecting by IPv4 through a relay', async t => {
  let requests = 0;
  const target = https.createServer(identity, (req, res) => { requests++; res.end('ipv4-connected'); });
  t.after(() => close(target)); const port = await listen(target);
  const relay = createOpaqueRelay({ targetPort: port }); t.after(() => close(relay)); const publicPort = await listen(relay);
  const url = `https://127.0.0.1:${publicPort}/healthz`;
  assert.match(await phone(url), /ipv4-connected/);
  assert.match(await phone(url, other.certificateSha256, 'reject'), /identity rejected before HTTP/);
  assert.equal(requests, 1);
});

test('phone TLS crosses an opaque relay without exposing its bearer token, request path or response', async t => {
  const upstream = https.createServer(identity, (req, res) => {
    assert.equal(req.url, '/healthz'); assert.equal(req.headers.authorization, 'Bearer synthetic-private-token');
    res.end('synthetic-private-answer');
  });
  t.after(() => close(upstream)); const port = await listen(upstream);
  const relay = createOpaqueRelay({ targetPort: port }); t.after(() => close(relay));
  const wire = []; relay.on('connection', socket => {
    const emit = socket.emit;
    socket.emit = function(event, ...args) {
      if (event === 'data') wire.push(Buffer.from(args[0]));
      return emit.call(this, event, ...args);
    };
    const write = socket.write;
    socket.write = function(chunk, ...args) { wire.push(Buffer.from(chunk)); return write.call(this, chunk, ...args); };
  });
  const publicPort = await listen(relay);
  assert.match(await phone(`https://localhost:${publicPort}/healthz`), /synthetic-private-answer/);
  const intercepted = Buffer.concat(wire);
  for (const secret of ['synthetic-private-token', '/healthz', 'synthetic-private-answer']) assert.ok(!intercepted.includes(Buffer.from(secret)));
});

test('a relay substituting its own certificate cannot receive even the first authenticated HTTP request', async t => {
  let requests = 0;
  const attacker = https.createServer(other, (req, res) => { requests++; res.end('stolen'); });
  t.after(() => close(attacker)); const port = await listen(attacker);
  const relay = createOpaqueRelay({ targetPort: port }); t.after(() => close(relay)); const publicPort = await listen(relay);
  assert.match(await phone(`https://localhost:${publicPort}/healthz`, identity.certificateSha256, 'reject'), /identity rejected before HTTP/);
  assert.equal(requests, 0);
});

test('invalid fingerprints fail closed and never fall back to the public CA store', async t => {
  let requests = 0;
  const server = https.createServer(identity, (req, res) => { requests++; res.end('unexpected'); });
  t.after(() => close(server)); const port = await listen(server);
  for (const pin of ['g'.repeat(64), 'a'.repeat(64), 'short']) {
    assert.match(await phone(`https://localhost:${port}/`, pin, 'reject'), /identity rejected before HTTP/);
  }
  assert.equal(requests, 0);
});

test('desktop gateway keeps backend authentication and streaming inside the encrypted endpoint', async t => {
  const upstream = https.createServer(identity, (req, res) => {
    if (req.headers.authorization !== 'Bearer local-private-token') { res.writeHead(401); res.end(); return; }
    if (req.url === '/healthz') { res.end('{"ok":true,"status":"ready"}'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"state","state":"sending"}\n');
    setTimeout(() => res.end('{"type":"done","text":"private-reply"}\n'), 50);
  });
  t.after(() => close(upstream)); const upstreamPort = await listen(upstream);
  const gateway = createDesktopGateway({ identity, hostname: 'localhost', backends: { paseo: { port: upstreamPort, ca: identity.cert,
    token: 'synthetic-private-token', upstreamToken: 'local-private-token' } } });
  t.after(() => close(gateway)); const gatewayPort = await listen(gateway);
  const relay = createOpaqueRelay({ targetPort: gatewayPort }); t.after(() => close(relay)); const publicPort = await listen(relay);
  assert.match(await phone(`https://localhost:${publicPort}/paseo/healthz`), /"ready"/);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const request = https.request({ hostname: 'localhost', port: publicPort, path: '/paseo/v1/chat/completions', method: 'POST', ca: identity.cert,
      headers: { authorization: 'Bearer synthetic-private-token', 'content-type': 'application/json' } }, response => {
      response.on('data', chunk => chunks.push(chunk.toString())); response.on('end', resolve); response.on('error', reject);
    });
    request.on('error', reject); request.end('{"stream":true,"messages":[{"role":"user","content":"private-question"}]}');
  });
  assert.match(chunks.join(''), /private-reply/); assert.ok(chunks.length >= 2);
  const status = await new Promise((resolve, reject) => {
    https.get(`https://localhost:${publicPort}/codex/healthz`, { ca: identity.cert }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 404);
});

test('gateway can add a newly configured backend without interrupting the existing route', async t => {
  const upstream = https.createServer(identity, (req, res) => { if (req.headers.authorization !== 'Bearer local-token') { res.writeHead(401); res.end(); return; } res.end('ready'); });
  t.after(() => close(upstream)); const upstreamPort = await listen(upstream);
  const local = { port: upstreamPort, ca: identity.cert, token: 'phone-token', upstreamToken: 'local-token' };
  let dynamic = { paseo: local };
  const gateway = createDesktopGateway({ identity, hostname: 'localhost', backends: dynamic, getBackends: () => dynamic });
  t.after(() => close(gateway)); const port = await listen(gateway);
  async function status(path, token = 'phone-token') { return await new Promise((resolve, reject) => {
    https.get(`https://localhost:${port}${path}`, { ca: identity.cert, headers: { authorization: 'Bearer ' + token } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  }); }
  assert.equal(await status('/paseo/healthz'), 200); assert.equal(await status('/codex/healthz'), 404);
  dynamic = { paseo: local, codex: local };
  assert.equal(await status('/codex/healthz'), 200);
  assert.equal(await status('/codex/healthz', 'wrong'), 401);
  assert.equal(await status('/paseo/healthz'), 200);
});

test('relay accepts only an allocated local target and bounds concurrent connections', () => {
  for (const options of [{ targetPort: 0 }, { targetPort: 65536 }, { targetPort: 1234, targetHost: 'external.test' }, { targetPort: 1234, maxConnections: 0 }]) {
    assert.throws(() => createOpaqueRelay(options), { code: 'RELAY_CONFIG_INVALID' });
  }
});

test('desktop gateway rejects unauthorised phones before contacting a local assistant', async t => {
  let localRequests = 0;
  const upstream = https.createServer(identity, (req, res) => { localRequests++; res.end('unexpected'); });
  t.after(() => close(upstream)); const localPort = await listen(upstream);
  const gateway = createDesktopGateway({ identity, hostname: 'localhost', backends: { paseo: { port: localPort, ca: identity.cert,
    token: 'phone-private-token', upstreamToken: 'local-private-token' } } });
  t.after(() => close(gateway)); const port = await listen(gateway);
  for (const headers of [{}, { authorization: 'Bearer local-private-token' }, { authorization: 'Bearer wrong' }]) {
    const status = await new Promise((resolve, reject) => https.get(`https://localhost:${port}/paseo/healthz`, { ca: identity.cert, headers }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject));
    assert.equal(status, 401);
  }
  assert.equal(localRequests, 0);
});

test('a matching pin still rejects a hostname absent from the scanned certificate', async t => {
  let requests = 0;
  const server = https.createServer(identity, (req, res) => { requests++; res.end('unexpected'); });
  t.after(() => close(server));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.3', resolve); });
  assert.match(await phone(`https://127.0.0.3:${server.address().port}/`, identity.certificateSha256, 'reject'), /identity rejected before HTTP/);
  assert.equal(requests, 0);
});

test('a second connection from a capped source is refused without interrupting its first connection', async t => {
  let targets = 0, connected;
  const accepted = new Promise(resolve => connected = resolve);
  const target = net.createServer(socket => { targets++; socket.on('data', chunk => socket.write(chunk)); connected(); });
  t.after(() => close(target)); const targetPort = await listen(target);
  const relay = createOpaqueRelay({ targetPort, maxPerIp: 1 }); t.after(() => close(relay)); const port = await listen(relay);
  const first = net.connect({ host: '127.0.0.1', port }); t.after(() => first.destroy()); await accepted;
  const second = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => { second.once('close', resolve); second.once('error', () => {}); second.setTimeout(1000, () => { second.destroy(); reject(Error('limit did not reject connection')); }); });
  assert.equal(targets, 1);
  const echo = new Promise(resolve => first.once('data', bytes => resolve(bytes.toString())));
  first.write('connection-still-works'); assert.equal(await echo, 'connection-still-works'); first.destroy();
});
