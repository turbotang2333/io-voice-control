import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { tlsFixture, listen, close } from './helpers/tls-fixture.mjs';
import { createOpaqueRelay } from '../relay/server.mjs';
import { startSecureLinkService, inspectSecureLink, issueSecurePairing } from '../secure-link/service.mjs';

const identity = tlsFixture('secure-service');
test('secure service requests its exact private socket as the SSH destination', async () => {
  const remoteSocket = '/tunnel/relay.sock';
  let requested;
  const service = await startSecureLinkService({ configuration: { identity, directory: identity.directory, sshHost: 'synthetic-host',
    invitation: { publicBaseUrl: 'https://localhost:24443', remoteSocket },
    backends: { paseo: { port: 7468, ca: identity.cert, token: 'b'.repeat(64), upstreamToken: 'a'.repeat(64) } } },
    startTunnel: ({ args }) => { requested = args[args.indexOf('-R') + 1]; return { stop: async () => {} }; } });
  try { assert.match(requested, new RegExp('^' + remoteSocket + ':127\\.0\\.0\\.1:[0-9]+$')); }
  finally { await service.stop(); }
});

test('a later Codex route can be verified and paired without disconnecting Paseo', async t => {
  const upstream = https.createServer(identity, (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + 'a'.repeat(64)) { res.writeHead(401); res.end(); return; }
    res.end('{"ok":true,"status":"ready"}');
  });
  t.after(() => close(upstream)); const port = await listen(upstream);
  const reserve = net.createServer(); const publicPort = await listen(reserve); await close(reserve);
  const route = { port, ca: identity.cert, token: 'b'.repeat(64), upstreamToken: 'a'.repeat(64) };
  const config = { identity, directory: identity.directory, sshHost: 'synthetic-host',
    invitation: { publicBaseUrl: `https://127.0.0.2:${publicPort}`, remotePort: 28001, hosting: 'project-hosted' },
    backends: { paseo: route }, profiles: { paseo: { endpoint: `https://127.0.0.2:${publicPort}/paseo`, port, token: route.token } } };
  const service = await startSecureLinkService({ configuration: config, getBackends: () => config.backends, startTunnel: async ({ args }) => {
    const local = Number(args[args.indexOf('-R') + 1].split(':').at(-1)); const relay = createOpaqueRelay({ targetPort: local });
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(publicPort, '127.0.0.2', resolve); });
    return { stop: () => close(relay) };
  } });
  t.after(() => service.stop());
  config.backends = { ...config.backends, codex: { ...route, token: 'c'.repeat(64) } };
  config.profiles.codex = { endpoint: `https://127.0.0.2:${publicPort}/codex`, port, token: 'c'.repeat(64) };
  const status = await inspectSecureLink(config);
  assert.deepEqual(status.connections.map(item => [item.backend, item.ready]), [['paseo', true], ['codex', true]]);
  const ticket = await issueSecurePairing(config, service.pairing, '测试电脑');
  const fields = new URLSearchParams(new URL(ticket.url).hash.slice(1));
  const result = await new Promise((resolve, reject) => {
    const request = https.request(new URL('/codex/v1/pairing/claim', config.invitation.publicBaseUrl), { method: 'POST', ca: identity.cert,
      headers: { 'content-type': 'application/json' } }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); });
    request.on('error', reject); request.end(JSON.stringify({ version: 1, code: fields.get('rayneo_pair') }));
  });
  assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.body.profiles).sort(), ['codex', 'paseo']);
});
for (const mode of ['paseo', 'codex', 'codex-with-offline-paseo']) {
test(`${mode} secure service verifies and pairs without submitting an assistant task`, async t => {
  const active = mode === 'paseo' ? 'paseo' : 'codex';
  let tasks = 0;
  const backend = https.createServer(identity, (req, res) => {
    if (req.url !== '/healthz') { tasks++; res.writeHead(500); res.end(); return; }
    if (req.headers.authorization !== 'Bearer ' + 'a'.repeat(64)) { res.writeHead(401); res.end(); return; }
    res.end('{"ok":true,"status":"ready"}');
  });
  t.after(() => close(backend)); const port = await listen(backend);
  const reserve = net.createServer(); const publicPort = await listen(reserve); await close(reserve);
  const config = { identity, directory: identity.directory, sshHost: 'synthetic-host',
    invitation: { publicBaseUrl: `https://127.0.0.2:${publicPort}`, remotePort: 28001, hosting: 'self-hosted' },
    backends: { [active]: { port, ca: identity.cert, token: 'b'.repeat(64), upstreamToken: 'a'.repeat(64) } },
    profiles: { [active]: { endpoint: `https://127.0.0.2:${publicPort}/${active}`, port, token: 'b'.repeat(64) } } };
  if (mode === 'codex-with-offline-paseo') {
    const offline = https.createServer(identity, (req, res) => { res.writeHead(503); res.end('{"ok":false,"status":"reconnecting"}'); });
    t.after(() => close(offline)); const offlinePort = await listen(offline);
    config.backends.paseo = { port: offlinePort, ca: identity.cert, token: 'c'.repeat(64), upstreamToken: 'd'.repeat(64) };
    config.profiles.paseo = { endpoint: `https://127.0.0.2:${publicPort}/paseo`, port: offlinePort, token: 'c'.repeat(64) };
  }
  const service = await startSecureLinkService({ configuration: config, startTunnel: async ({ args }) => {
    const local = Number(args[args.indexOf('-R') + 1].split(':').at(-1));
    const relay = createOpaqueRelay({ targetPort: local });
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(publicPort, '127.0.0.2', resolve); });
    return { stop: () => close(relay) };
  } });
  t.after(() => service.stop());
  const status = await inspectSecureLink(config);
  assert.equal(status.encryption, 'verified'); assert.equal(status.pairingReady, true);
  assert.equal(status.connections.find(value => value.backend === active).ready, true);
  const ticket = await issueSecurePairing(config, service.pairing, '测试电脑');
  const qr = new URL(ticket.url), fields = new URLSearchParams(qr.hash.slice(1));
  assert.equal(fields.get('tls_sha256'), identity.certificateSha256);
  const claim = await new Promise((resolve, reject) => {
    const request = https.request(new URL(`/${active}/v1/pairing/claim`, config.invitation.publicBaseUrl), { method: 'POST', ca: identity.cert,
      headers: { 'content-type': 'application/json' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); response.on('error', reject);
    });
    request.on('error', reject); request.end(JSON.stringify({ version: 1, code: fields.get('rayneo_pair') }));
  });
  assert.equal(claim.status, 200); assert.equal(claim.body.version, 2);
  assert.equal(claim.body.profiles[active].token, 'b'.repeat(64)); assert.ok(!JSON.stringify(claim).includes('a'.repeat(64)));
  if (mode === 'codex-with-offline-paseo') assert.equal(claim.body.profiles.paseo, undefined);
  assert.equal(tasks, 0);
  const methodStatus = await new Promise((resolve, reject) => {
    const request = https.request(new URL(`/${active}/pair`, config.invitation.publicBaseUrl), { method: 'POST', ca: identity.cert }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.setTimeout(1200, () => request.destroy(Error('pairing method left hanging')));
    request.on('error', reject); request.end();
  });
  assert.equal(methodStatus, 405);
  await service.stop();
  const offline = await inspectSecureLink(config, { timeoutMs: 500 });
  assert.equal(offline.encryption, 'unverified'); assert.equal(offline.pairingReady, false);
  assert.equal(config.identity.certificateSha256, identity.certificateSha256);
});
}

test('a failed tunnel start releases the local encrypted listener and leaves native assistants alone', async () => {
  await assert.rejects(startSecureLinkService({ configuration: { identity, directory: identity.directory, sshHost: 'synthetic-host',
    invitation: { publicBaseUrl: 'https://localhost:24443', remotePort: 28001 },
    backends: { paseo: { port: 7468, ca: identity.cert, token: 'b'.repeat(64), upstreamToken: 'a'.repeat(64) } } },
    startTunnel: () => { throw Error('synthetic tunnel unavailable'); } }), /synthetic tunnel unavailable/);
});

test('a tunnel stop error still closes the owned encrypted listener', async () => {
  let localPort;
  const service = await startSecureLinkService({ configuration: { identity, directory: identity.directory, sshHost: 'synthetic-host',
    invitation: { publicBaseUrl: 'https://localhost:24443', remotePort: 28001 },
    backends: { codex: { port: 19469, ca: identity.cert, token: 'b'.repeat(64), upstreamToken: 'a'.repeat(64) } } },
    startTunnel: ({ args }) => {
      localPort = Number(args[args.indexOf('-R') + 1].split(':').at(-1));
      return { stop: async () => { throw Error('synthetic stop failure'); } };
    } });
  await assert.rejects(service.stop(), /synthetic stop failure/);
  const reuse = net.createServer();
  await new Promise((resolve, reject) => { reuse.once('error', reject); reuse.listen(localPort, '127.0.0.1', resolve); });
  await close(reuse);
});

test('stopping the secure service also closes clients that never finish their TLS handshake', async () => {
  let localPort;
  const service = await startSecureLinkService({ configuration: { identity, directory: identity.directory, sshHost: 'synthetic-host',
    invitation: { publicBaseUrl: 'https://localhost:24443', remotePort: 28001 },
    backends: { codex: { port: 19469, ca: identity.cert, token: 'b'.repeat(64), upstreamToken: 'a'.repeat(64) } } },
    startTunnel: ({ args }) => { localPort = Number(args[args.indexOf('-R') + 1].split(':').at(-1)); return { stop: async () => {} }; } });
  const socket = net.connect({ host: '127.0.0.1', port: localPort });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const stopped = service.stop(); let timer;
  const timely = await Promise.race([stopped.then(() => true), new Promise(resolve => timer = setTimeout(() => resolve(false), 500))]);
  clearTimeout(timer); socket.destroy(); await stopped;
  assert.equal(timely, true);
});
