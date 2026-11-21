// Run only in the dedicated disposable WSL distribution; listeners bind loopback.
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { accountForInstallation, createSharedSshConfig } from '../../relay/shared-configuration.mjs';
import { createSharedAccountDriver } from '../../relay/shared-account-driver.mjs';
import { createSharedHostedRuntime } from '../../relay/shared-hosted-runtime.mjs';

assert.equal(process.env.RAYNEO_ISOLATED_SYSTEMD_TEST, '1');
assert.equal(process.getuid(), 0);
assert.equal(existsSync('/etc/rayneo-isolated-systemd-test-only'), true);
const base = '/var/lib/rayneo-shared';
assert.equal(existsSync(base), false, 'Never reuse a pre-existing installation');
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
const runAsync = promisify(execFile);
const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const tmp = mkdtempSync('/run/rayneo-shared-test-');
const suffix = randomBytes(4).toString('hex'), group = `rnpt${suffix}`, routerUser = `rnpr${suffix}`;
const users = [randomUUID(), randomUUID()].map(id => ({ id, name: accountForInstallation(id) }));
const createdUsers = [], children = [], servers = []; let groupCreated = false, madeBase = false, runtime;
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); });
};
try {
  mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
  mkdirSync(base, { mode: 0o755 }); madeBase = true;
  run('groupadd', ['--system', group]); groupCreated = true;
  run('useradd', ['--system', '--no-create-home', '--gid', group, '--shell', '/usr/sbin/nologin', routerUser]); createdUsers.push(routerUser);
  const hostKey = readFileSync('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  const driver = createSharedAccountDriver({ group, verifyInfrastructure: async () => true });
  const port = await freePort(), routerPort = await freePort();
  const shared = { publicBaseUrl: `https://relay.example.test:${routerPort}`, relay: { host: 'ssh.example.test', port, hostKey } };
  const makeCert = (name, label) => {
    const key = join(tmp, label + '.key'), cert = join(tmp, label + '.crt');
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + name,
      '-addext', 'subjectAltName=DNS:' + name, '-keyout', key, '-out', cert]);
    return { key: readFileSync(key), cert: readFileSync(cert) };
  };
  const enrollmentTls = makeCert('localhost', 'enrollment');
  runtime = await createSharedHostedRuntime({ databasePath: join(tmp, 'registry.sqlite'), shared, tls: enrollmentTls,
    activate: async bundle => { createdUsers.push(bundle.invitation.relay.user); return driver.activate(bundle); }, inspect: driver.inspect });
  await new Promise((resolve, reject) => runtime.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const enroll = request => new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = https.request({ host: '127.0.0.1', port: runtime.server.address().port, servername: 'localhost', ca: enrollmentTls.cert,
      path: '/v1/enroll', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(Buffer.concat(chunks))) : reject(Error('Enrollment rejected: ' + res.statusCode)));
    }); req.once('error', reject); req.end(body);
  });
  for (const user of users) {
    user.key = join(tmp, user.name); run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', user.key]);
    user.enrollment = { version: 1, installationId: user.id, requestedBackends: ['paseo'], sshPublicKey: readFileSync(user.key + '.pub', 'utf8').trim() };
    user.invitation = await enroll(user.enrollment);
    assert.equal(user.invitation.relay.user, user.name); assert.equal(user.invitation.relay.port, port);
    assert.equal(new URL(user.invitation.publicBaseUrl).port, String(routerPort));
    user.identity = makeCert(`${user.id}.relay.example.test`, user.name);
    user.backend = tls.createServer(user.identity, socket => socket.end(user.name)); servers.push(user.backend);
    await new Promise((resolve, reject) => user.backend.once('error', reject).listen(0, '127.0.0.1', resolve));
  }
  assert.deepEqual(await enroll(users[0].enrollment), users[0].invitation);
  const config = join(tmp, 'sshd_config');
  writeFileSync(config, createSharedSshConfig({ port, listenHost: '127.0.0.1' }));
  run('/usr/sbin/sshd', ['-t', '-f', config]);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] }); children.push(sshd);
  let sshdErrors = ''; sshd.stderr.on('data', chunk => { sshdErrors += chunk; });
  const sshArgs = user => ['-i', user.key, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-p', String(port)];
  for (const user of users) {
    user.ssh = spawn('ssh', [...sshArgs(user), '-N', '-R', `/tunnel/relay.sock:127.0.0.1:${user.backend.address().port}`, `${user.name}@127.0.0.1`], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(user.ssh); user.errors = ''; user.ssh.stderr.on('data', chunk => { user.errors += chunk; });
  }
  const deadline = Date.now() + 10000;
  while (users.some(user => !existsSync(join(base, user.name, 'tunnel/relay.sock')))) {
    if (users.some(user => user.ssh.exitCode !== null) || sshd.exitCode !== null || Date.now() > deadline) throw Error('SSH setup failed: ' + sshdErrors + users.map(u => u.errors).join(''));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const user of users) {
    const path = join(base, user.name, 'tunnel/relay.sock');
    const { stdout } = await runAsync('runuser', ['-u', routerUser, '--', process.execPath, '-e',
      "const s=require('tls').connect({socket:require('net').connect(process.argv[1]),rejectUnauthorized:false});s.on('data',x=>process.stdout.write(x));s.on('error',()=>process.exit(2))", path], { timeout: 15000 });
    assert.equal(stdout, user.name, 'unprivileged router reaches only the matching tunnel');
  }
  const routerSource = new URL('../../relay/shared-router.mjs', import.meta.url).href;
  const configSource = new URL('../../relay/shared-configuration.mjs', import.meta.url).href;
  const script = `import {createSharedRelay} from ${JSON.stringify(routerSource)}; import {createSharedRouteConnector} from ${JSON.stringify(configSource)};
    const server=createSharedRelay({connectRoute:createSharedRouteConnector({suffix:'relay.example.test'})});
    server.listen(Number(process.argv[1]),'127.0.0.1',()=>console.log('READY'));`;
  const router = spawn('runuser', ['-u', routerUser, '--', process.execPath, '--input-type=module', '-e', script, String(routerPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(router);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Router startup timeout')), 10000); let error = '';
    router.stderr.on('data', b => { error += b; });
    router.stdout.on('data', b => { if (b.toString().includes('READY')) { clearTimeout(timer); resolve(); } });
    router.once('exit', () => { clearTimeout(timer); reject(Error('Router exited: ' + error)); });
  });
  const connect = (user, ca = user.identity.cert) => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: routerPort, servername: `${user.id}.relay.example.test`, ca }); let result = '';
    socket.on('data', b => { result += b; }); socket.on('end', () => resolve(result)); socket.on('error', reject);
  });
  assert.deepEqual(await Promise.all(users.map(user => connect(user))), users.map(user => user.name));
  await assert.rejects(connect(users[0], users[1].identity.cert));
  // A tunneled account cannot open a shell or forward outside its chroot.
  for (const args of [
    [...sshArgs(users[0]), `${users[0].name}@127.0.0.1`, 'id'],
    [...sshArgs(users[0]), '-N', '-R', `/../${users[1].name}/tunnel/stolen.sock:127.0.0.1:${users[0].backend.address().port}`, `${users[0].name}@127.0.0.1`],
    [...sshArgs(users[0]), '-N', '-R', `127.0.0.1:39999:127.0.0.1:${users[0].backend.address().port}`, `${users[0].name}@127.0.0.1`]
  ]) assert.throws(() => run('ssh', args));
  assert.equal(existsSync(join(base, users[1].name, 'tunnel/stolen.sock')), false);
  console.log('SHARED_HTTPS_ENROLLMENT_SSH_TLS_TWO_USERS_OK');
} finally {
  if (runtime) await runtime.close();
  for (const child of children.reverse()) await stop(child);
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  for (const user of createdUsers.reverse()) run('userdel', [user]);
  if (groupCreated) run('groupdel', [group]);
  if (madeBase) rmSync(base, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}
