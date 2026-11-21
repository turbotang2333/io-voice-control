import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpaqueRelay } from '../relay/server.mjs';
import { relayArguments } from '../bridge/supervisor.mjs';
import { validateSecureInvitation } from '../secure-link/config.mjs';

test('SSH supports only the per-installation private socket path for a secure relay', () => {
  const path = '/tunnel/relay.sock';
  const args = relayArguments({ sshHost: 'secure-host', remoteSocket: path }, 7468);
  assert.ok(args.includes(path + ':127.0.0.1:7468'));
  for (const remoteSocket of ['/tmp/other.sock', path + '\nUnsafe', path.replace('tunnel/', '../')]) {
    assert.throws(() => relayArguments({ sshHost: 'secure-host', remoteSocket }, 7468));
  }
});

test('a private-socket invitation must name exactly this computer’s isolated path', () => {
  const installationId = randomUUID(), remoteSocket = '/tunnel/relay.sock';
  const hostKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const value = { version: 3, transport: 'tls-passthrough-v1', hosting: 'self-hosted', installationId,
    publicBaseUrl: 'https://relay.example.test:24443', remoteSocket, backends: ['paseo'],
    relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey } };
  assert.equal(validateSecureInvitation(value).remoteSocket, remoteSocket);
  for (const bad of ['/tmp/relay.sock', '/tunnel/other.sock', remoteSocket + '\nno']) {
    assert.throws(() => validateSecureInvitation({ ...value, remoteSocket: bad }), { code: 'SECURE_INVITATION_INVALID' });
  }
  assert.throws(() => validateSecureInvitation({ ...value, remotePort: 28001 }), { code: 'SECURE_INVITATION_INVALID' });
});

test('an unavailable private socket never redirects public traffic to an unrelated TCP listener', { skip: process.platform === 'win32' }, async t => {
  const parent = join(tmpdir(), 'rayneo-relay-tests'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'private-')), targetSocket = join(directory, 'relay.sock');
  let unrelatedRequests = 0;
  const unrelated = createServer(socket => { unrelatedRequests++; socket.end('unrelated'); });
  await new Promise((accept, reject) => { unrelated.once('error', reject); unrelated.listen(0, '127.0.0.1', accept); });
  const target = createServer(socket => socket.end('private tunnel'));
  await new Promise((accept, reject) => { target.once('error', reject); target.listen(targetSocket, accept); });
  const relay = createOpaqueRelay({ targetSocket });
  await new Promise((accept, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', accept); });
  t.after(async () => {
    relay.closeAllConnections(); await new Promise(accept => relay.close(accept));
    await new Promise(accept => unrelated.close(accept));
    rmSync(directory, { recursive: true, force: true });
  });
  const exchange = () => new Promise((accept, reject) => {
    let body = ''; const socket = connect(relay.address().port, '127.0.0.1');
    socket.setEncoding('utf8'); socket.on('data', chunk => { body += chunk; });
    socket.on('close', () => accept(body)); socket.on('error', reject);
  });
  assert.equal(await exchange(), 'private tunnel');
  await new Promise(accept => target.close(accept));
  assert.equal(await exchange(), ''); assert.equal(unrelatedRequests, 0);
});
