// Explicitly authorized manual acceptance only. Uses synthetic identities and content.
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { tlsFixture, listen, close } from '../helpers/tls-fixture.mjs';
import { validateHostedResponse } from '../../distribution/hosted-enrollment.mjs';

assert.equal(process.env.RAYNEO_APPROVED_REAL_SERVER_TEST, '1');
const host = process.env.RAYNEO_TEST_HOST, address = process.env.RAYNEO_TEST_ADDRESS;
assert.match(host ?? '', /^[a-z0-9.-]+$/); assert.match(address ?? '', /^(?:\d{1,3}\.){3}\d{1,3}$/);
const identities = [0, 1].map(i => ({ id: randomUUID(), index: i }));
const roots = [], servers = [], children = [];
const cleanupRoot = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/shared-public-acceptance');
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveStop => { child.once('exit', resolveStop); child.kill(); setTimeout(resolveStop, 3000).unref(); });
};
const post = body => new Promise((resolvePost, reject) => {
  const text = JSON.stringify(body), req = https.request({ host: address, servername: host, port: 29445, path: '/v1/enroll', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, timeout: 15000 }, res => {
    const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => {
      if (res.statusCode !== 200) return reject(Error('enrollment status ' + res.statusCode));
      try { resolvePost(JSON.parse(Buffer.concat(parts))); } catch (error) { reject(error); }
    });
  }); req.on('timeout', () => req.destroy(Error('enrollment timeout'))); req.on('error', reject); req.end(text);
});
try {
  for (const item of identities) {
    const hostname = `${item.id}.relay.${host}`;
    item.identity = tlsFixture('shared-public-acceptance', { extraDnsNames: [hostname] }); roots.push(item.identity.directory);
    item.keyPath = join(item.identity.directory, 'test-ssh-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', item.keyPath], { stdio: 'pipe', timeout: 15000 });
    const enrollment = { version: 1, installationId: item.id, requestedBackends: ['paseo'],
      sshPublicKey: readFileSync(item.keyPath + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ') };
    item.invitation = validateHostedResponse(await post(enrollment), enrollment);
    assert.equal(item.invitation.publicBaseUrl, `https://${hostname}:29443`);
    assert.equal(item.invitation.relay.port, 29444);
    item.knownHosts = join(item.identity.directory, 'known_hosts');
    writeFileSync(item.knownHosts, 'rayneo-test ' + item.invitation.relay.hostKey + '\n', { flag: 'wx', mode: 0o600 });
    item.requests = 0;
    item.server = https.createServer(item.identity, (req, res) => {
      item.requests++; assert.equal(req.headers.authorization, 'Bearer synthetic-test-token'); res.end(`synthetic-desktop-${item.index}`);
    }); servers.push(item.server); const port = await listen(item.server);
    item.ssh = spawn('ssh', ['-N', '-i', item.keyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${item.knownHosts}`, '-o', 'HostKeyAlias=rayneo-test',
      '-p', '29444', '-R', `/tunnel/relay.sock:127.0.0.1:${port}`, `${item.invitation.relay.user}@${address}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(item.ssh); item.errors = ''; item.ssh.stderr.on('data', b => { item.errors += b; });
  }
  const request = (item, cert = item.identity.cert) => new Promise((resolveRequest, reject) => {
    const req = https.get({ host: address, port: 29443, servername: `${item.id}.relay.${host}`, ca: cert,
      path: '/synthetic', headers: { authorization: 'Bearer synthetic-test-token' }, timeout: 5000 }, res => {
      let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolveRequest(body));
    }); req.on('timeout', () => req.destroy(Error('timeout'))); req.on('error', reject);
  });
  await Promise.all(identities.map(async item => {
    const deadline = Date.now() + 20000;
    while (true) {
      if (item.ssh.exitCode !== null) throw Error('test SSH exited: ' + item.errors);
      try { if (await request(item) === `synthetic-desktop-${item.index}`) return; } catch {}
      if (Date.now() > deadline) throw Error('test relay not ready');
      await new Promise(resolveWait => setTimeout(resolveWait, 300));
    }
  }));
  const before = identities[0].requests;
  await assert.rejects(request(identities[0], identities[1].identity.cert));
  assert.equal(identities[0].requests, before);
  console.log('PUBLIC_TWO_USERS_TLS_ISOLATION_OK');
} finally {
  for (const child of children) await stop(child);
  for (const server of servers) await close(server);
  for (const path of roots) {
    const resolved = resolve(path), safeRoot = resolve(cleanupRoot);
    if (!resolved.startsWith(safeRoot + sep)) throw Error('unsafe test cleanup path');
    rmSync(resolved, { recursive: true, force: true });
  }
}
