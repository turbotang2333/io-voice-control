// Only the explicitly marked, disposable WSL distribution may run this fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { createUnixRelayBundle } from '../../relay/unix-provision.mjs';
import { writeRelayBundle } from '../../relay/wizard.mjs';
import { createInstallPlan, createLinuxInstallDriver, installRelay, checkInstalledRelay } from '../../relay/install.mjs';
import { startSecureLinkService } from '../../secure-link/service.mjs';

assert.equal(process.env.RAYNEO_ISOLATED_SYSTEMD_TEST, '1');
assert.equal(process.getuid(), 0);
assert.ok(existsSync('/etc/rayneo-isolated-systemd-test-only'));
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const temp = mkdtempSync('/run/rayneo-ip-acceptance-');
const ip = '192.0.2.10', installationId = randomUUID(), user = 'rnp_' + installationId.replaceAll('-', '').slice(0, 20);
let service, upstream, installed = false, driver, plan;
try {
  mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(temp, 'client')]);
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=isolated-test',
    '-addext', `subjectAltName=IP:${ip},IP:127.0.0.1`, '-keyout', join(temp, 'tls.key'), '-out', join(temp, 'tls.crt')]);
  const cert = readFileSync(join(temp, 'tls.crt')), key = readFileSync(join(temp, 'tls.key'));
  const identity = { cert, key, certificateSha256: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') };
  const password = 'a'.repeat(64);
  command('openssl', ['pkcs12', '-export', '-inkey', join(temp, 'tls.key'), '-in', join(temp, 'tls.crt'), '-out', join(temp, 'server.p12'), '-passout', 'pass:' + password]);
  identity.pfx = readFileSync(join(temp, 'server.p12')); identity.passphrase = password;
  const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  const sshPublicKey = readFileSync(join(temp, 'client.pub'), 'utf8').trim();
  const publicPort = await freePort(), sshPort = await freePort(); assert.notEqual(publicPort, sshPort);
  const bundle = createUnixRelayBundle({ enrollment: { version: 1, installationId, requestedBackends: ['paseo'], sshPublicKey },
    hosting: 'self-hosted', publicBaseUrl: `https://${ip}:${publicPort}`, relay: { host: ip, port: sshPort, user, hostKey } });
  const output = join(temp, 'bundle');
  assert.equal(writeRelayBundle({ output, bundle }).prepared, true);
  const generated = { invitation: JSON.parse(readFileSync(join(output, 'invitation.json'), 'utf8')),
    relayConfig: JSON.parse(readFileSync(join(output, 'relay.json'), 'utf8')),
    authorizedKey: readFileSync(join(output, 'authorized-key'), 'utf8'), sshdConfig: readFileSync(join(output, 'sshd.conf'), 'utf8') };
  plan = createInstallPlan(generated, process.execPath);
  plan.sshdConfig = plan.sshdConfig.replace('ListenAddress 0.0.0.0', 'ListenAddress 127.0.0.1');
  plan.relayConfig = { ...plan.relayConfig, listenHost: '127.0.0.1' };
  driver = createLinuxInstallDriver({ serverSource: join(output, 'relay-server.mjs') });
  await installRelay(plan, driver); installed = true;
  assert.equal((await checkInstalledRelay(plan, driver)).sshConfigured, true);
  upstream = https.createServer({ key, cert }, (request, response) => response.end('{"ok":true,"status":"ready"}'));
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  const token = 'b'.repeat(64), configuration = { identity, directory: temp, sshHost: 'fixture',
    invitation: bundle.invitation, backends: { paseo: { port: upstream.address().port, ca: cert, token, upstreamToken: 'a'.repeat(64) } },
    profiles: { paseo: { endpoint: bundle.invitation.publicBaseUrl + '/paseo', port: upstream.address().port, token } } };
  const known = join(temp, 'known_hosts'); writeFileSync(known, 'fixture ' + hostKey + '\n');
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(temp, 'untrusted')]);
  const wrongKnown = join(temp, 'wrong_known_hosts');
  writeFileSync(wrongKnown, 'fixture ' + readFileSync(join(temp, 'untrusted.pub'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ') + '\n');
  const sshCheck = (keyPath, knownFile) => execFileSync('ssh', ['-N', '-i', keyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'HostKeyAlias=fixture', '-o', `UserKnownHostsFile=${knownFile}`, '-p', String(sshPort), `${user}@127.0.0.1`],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
  assert.throws(() => sshCheck(join(temp, 'client'), wrongKnown), error => error.status === 255 && /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(String(error.stderr)));
  assert.throws(() => sshCheck(join(temp, 'untrusted'), known), error => error.status === 255 && /Permission denied/.test(String(error.stderr)));
  const launch = async ({ args }) => {
    const forward = args[args.indexOf('-R') + 1];
    const child = spawn('ssh', ['-N', '-i', join(temp, 'client'), '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=fixture', '-o', `UserKnownHostsFile=${known}`, '-p', String(sshPort), '-R', forward, `${user}@127.0.0.1`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => stderr += data);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => child.exitCode === null ? resolve() : reject(Error(stderr)), 700); child.once('error', error => { clearTimeout(timer); reject(error); }); });
    return { stop: async () => { if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped; } } };
  };
  const exchange = (path, { authorization, body, fingerprint = identity.certificateSha256 } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: publicPort, path, method: body ? 'POST' : 'GET', ca: cert,
      headers: { host: `${ip}:${publicPort}`, ...(authorization ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      checkServerIdentity(_host, peer) { return tls.checkServerIdentity(ip, peer) || (createHash('sha256').update(peer.raw).digest('hex') !== fingerprint ? Error('pin mismatch') : undefined); } },
    res => { let content = ''; res.on('data', data => content += data); res.on('end', () => resolve({ status: res.statusCode, content })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  service = await startSecureLinkService({ configuration, startTunnel: launch });
  assert.equal((await exchange('/healthz')).status, 200);
  await assert.rejects(exchange('/healthz', { fingerprint: 'c'.repeat(64) }));
  assert.equal((await exchange('/paseo/healthz')).status, 401);
  assert.equal((await exchange('/paseo/healthz', { authorization: 'Bearer ' + token })).status, 200);
  const ticket = service.pairing.issue({ computerLabel: 'isolated', profiles: configuration.profiles,
    publicBaseUrl: configuration.profiles.paseo.endpoint, certificateSha256: identity.certificateSha256 });
  const proof = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('rayneo_pair');
  const claim = await exchange('/paseo/v1/pairing/claim', { body: { version: 1, code: proof } });
  assert.equal(claim.status, 200); assert.equal(JSON.parse(claim.content).transport.certificateSha256, identity.certificateSha256);
  assert.notEqual((await exchange('/paseo/v1/pairing/claim', { body: { version: 1, code: proof } })).status, 200);
  await service.stop(); service = null;
  service = await startSecureLinkService({ configuration, startTunnel: launch });
  assert.equal((await exchange('/healthz')).status, 200);
  process.stdout.write('ISOLATED_SELF_HOSTED_IPV4_INSTALL_PAIR_RECONNECT_OK\n');
} finally {
  await service?.stop();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  if (installed) await driver.rollback(plan);
  rmSync(temp, { recursive: true, force: true });
}
