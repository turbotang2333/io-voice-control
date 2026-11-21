import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { tlsFixture, listen, close } from './helpers/tls-fixture.mjs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHostedAllocator } from '../relay/hosted-allocator.mjs';

const api = await import('../relay/hosted-server.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
function enrollment() { return { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key }; }
function invitation(e) { return { version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: e.installationId,
  publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: e.requestedBackends,
  relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } }; }
async function call(handler, value, overrides = {}) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const req = Readable.from([bytes]); req.method = overrides.method ?? 'POST'; req.url = overrides.url ?? '/v1/enroll';
  req.headers = overrides.headers ?? { 'content-type': 'application/json' }; req.socket = { encrypted: overrides.encrypted ?? true, remoteAddress: overrides.ip ?? '127.0.0.1' };
  const res = { headersSent: false, writeHead(code, headers) { this.status = code; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  await handler(req, res); return res;
}

test('a secure hosted request forwards only the validated public enrollment and returns its matching invitation', async () => {
  let received; const input = enrollment();
  const handler = api.createHostedEnrollmentHandler({ provision: async value => { received = value; return invitation(value); } });
  const res = await call(handler, input);
  assert.equal(res.status, 200); assert.deepEqual(received, input);
  assert.equal(JSON.parse(res.body).installationId, input.installationId);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('when invitations are required, unauthorised requests cannot provision and the code is not passed to the provisioner', async () => {
  let calls = 0, authorizations = 0;
  const input = enrollment(), code = 'rnp-' + 'A'.repeat(43);
  const handler = api.createHostedEnrollmentHandler({ authorize: async (value, supplied) => {
    authorizations++; assert.deepEqual(value, input); return supplied === code;
  }, provision: async value => { calls++; assert.deepEqual(value, input); return invitation(value); } });
  assert.equal((await call(handler, input)).status, 403);
  assert.equal((await call(handler, input, { headers: { 'content-type': 'application/json', 'x-invite-code': code } })).status, 200);
  assert.equal(authorizations, 2); assert.equal(calls, 1);
});

test('private, malformed, oversized and unencrypted requests never reach the provisioner', async () => {
  let calls = 0; const handler = api.createHostedEnrollmentHandler({ provision: async value => { calls++; return invitation(value); }, maxRequestsPerMinute: 100 });
  assert.equal((await call(handler, { ...enrollment(), secret: 'should-not-be-sent' })).status, 400);
  assert.equal((await call(handler, '{')).status, 400);
  assert.equal((await call(handler, 'x'.repeat(17000))).status, 413);
  assert.equal((await call(handler, enrollment(), { encrypted: false })).status, 400);
  assert.equal((await call(handler, enrollment(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(calls, 0);
});

test('limits concurrent applications and per-client request rate without trusting forwarded IP headers', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let calls = 0;
  const handler = api.createHostedEnrollmentHandler({ maxConcurrent: 1, maxRequestsPerMinute: 2,
    provision: async value => { calls++; await waiting; return invitation(value); } });
  const first = call(handler, enrollment()); await new Promise(resolve => setImmediate(resolve));
  const second = await call(handler, enrollment(), { headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' } });
  assert.equal(second.status, 503); release(); assert.equal((await first).status, 200);
  assert.equal((await call(handler, enrollment())).status, 429); assert.equal(calls, 1);
});

test('rate limits expire while the number of tracked clients stays bounded', async () => {
  let time = 1000;
  const handler = api.createHostedEnrollmentHandler({ maxClients: 1, maxRequestsPerMinute: 1, now: () => time,
    provision: async value => invitation(value) });
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.1' })).status, 200);
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.2' })).status, 429);
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.1' })).status, 429);
  time += 60000;
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.2' })).status, 200);
});

test('global registration limit applies across different IP addresses', async () => {
  let time = 1000, calls = 0;
  const handler = api.createHostedEnrollmentHandler({ maxGlobalRequestsPerMinute: 2, now: () => time,
    provision: async value => { calls++; return invitation(value); } });
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.1' })).status, 200);
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.2' })).status, 200);
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.3' })).status, 429);
  assert.equal(calls, 2);
  time += 60000;
  assert.equal((await call(handler, enrollment(), { ip: '192.0.2.3' })).status, 200);
});

test('an incomplete application times out and releases the processing slot', async () => {
  const handler = api.createHostedEnrollmentHandler({ timeoutMs: 100, maxConcurrent: 1, provision: async value => invitation(value) });
  const req = new Readable({ read() {} }); req.method = 'POST'; req.url = '/v1/enroll';
  req.headers = { 'content-type': 'application/json' }; req.socket = { encrypted: true, remoteAddress: '127.0.0.1' };
  const res = { headersSent: false, writeHead(code) { this.status = code; this.headersSent = true; }, end() {} };
  const keepAlive = setTimeout(() => {}, 1000);
  try { await handler(req, res); } finally { clearTimeout(keepAlive); }
  assert.equal(res.status, 400);
  assert.equal((await call(handler, enrollment())).status, 200);
});

test('a provisioning error or an invitation for another computer is never returned as a success', async () => {
  for (const provision of [async () => { throw Error('private internal error'); }, async value => invitation({ ...value, installationId: randomUUID() })]) {
    const res = await call(api.createHostedEnrollmentHandler({ provision }), enrollment());
    assert.equal(res.status, 503); assert.ok(!res.body.includes('private internal error'));
  }
});

test('real local HTTPS accepts a valid application and rejects extra fields before provisioning', async t => {
  const identity = tlsFixture('hosted-server'), input = enrollment(); let calls = 0;
  const handler = api.createHostedEnrollmentHandler({ provision: async value => { calls++; return invitation(value); } });
  const server = https.createServer(identity, (req, res) => { void handler(req, res); });
  t.after(() => close(server)); const port = await listen(server);
  async function send(value) {
    const body = JSON.stringify(value);
    return await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, path: '/v1/enroll', method: 'POST', ca: identity.cert,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  const accepted = await send(input); assert.equal(accepted.status, 200); assert.equal(accepted.body.installationId, input.installationId);
  assert.equal((await send({ ...input, secret: 'synthetic' })).status, 400); assert.equal(calls, 1);
});

test('the HTTPS endpoint and persistent allocator reuse the same allocation without a second activation', async t => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/hosted-server-allocator'); mkdirSync(parent, { recursive: true });
  const databasePath = join(mkdtempSync(join(parent, 'fixture-')), 'registry.sqlite'); let calls = 0;
  const allocator = await createHostedAllocator({ databasePath, slots: [{ id: 'one', publicBaseUrl: 'https://relay.example.test:24443',
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } }], activate: async () => { calls++; return true; } });
  const identity = tlsFixture('hosted-server-allocator');
  const server = https.createServer(identity, (req, res) => { void createHandler(req, res); });
  const createHandler = api.createHostedEnrollmentHandler({ provision: allocator.provision });
  t.after(async () => { await close(server); allocator.close(); }); const port = await listen(server);
  async function send(value) {
    const body = JSON.stringify(value);
    return await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', servername: 'localhost', port, path: '/v1/enroll', method: 'POST', ca: identity.cert,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on('error', reject); req.end(body);
    });
  }
  const input = enrollment(), first = await send(input), again = await send(input);
  assert.equal(first.status, 200); assert.deepEqual(again, first); assert.equal(calls, 1);
  assert.equal((await send(enrollment())).status, 503); assert.equal(calls, 1);
});
