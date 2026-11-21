import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accountForInstallation, sharedHostname, sharedSocket, createSharedSshConfig, createSharedRouteConnector, createSharedRelayBundle } from '../relay/shared-configuration.mjs';
import { validateHostedResponse } from '../distribution/hosted-enrollment.mjs';

const id = '8e91d779-1cdd-4f61-9f48-596141e30fe7';
test('each computer receives a stable isolated account, hostname and socket', () => {
  const account = accountForInstallation(id);
  assert.match(account, /^rnp_[a-z2-7]{26}$/);
  assert.equal(account, accountForInstallation(id));
  assert.notEqual(account, accountForInstallation(randomUUID()));
  assert.equal(sharedHostname(id, 'relay.example.test'), `${id}.relay.example.test`);
  assert.equal(sharedSocket(id), `/var/lib/rayneo-shared/${account}/tunnel/relay.sock`);
  for (const bad of ['../x', id.toUpperCase(), '']) assert.throws(() => accountForInstallation(bad));
});

test('shared SSH service confines every account and permits no command sessions or TCP forwarding', () => {
  const config = createSharedSshConfig({ port: 2222 });
  for (const line of [
    'Port 2222', 'ChrootDirectory /var/lib/rayneo-shared/%u', 'AuthorizedKeysFile /var/lib/rayneo-shared/%u/authorized_keys',
    'AllowUsers rnp_*', 'AllowTcpForwarding remote', 'PermitListen none', 'AllowStreamLocalForwarding remote',
    'StreamLocalBindMask 0117', 'PermitTTY no', 'MaxSessions 0', 'PasswordAuthentication no'
  ]) assert.ok(config.includes(line + '\n'), line);
  for (const port of [0, 65536, '2222']) assert.throws(() => createSharedSshConfig({ port }));
});

test('routing accepts only an installation hostname under the configured suffix', () => {
  const calls = [];
  const connect = createSharedRouteConnector({ suffix: 'relay.example.test', connectSocket: path => { calls.push(path); return 'connected'; } });
  assert.equal(connect(`${id}.relay.example.test`), 'connected');
  assert.deepEqual(calls, [sharedSocket(id)]);
  for (const name of [`${id}.relay.example.test.evil`, `x.${id}.relay.example.test`, 'invalid.relay.example.test', `${id}.other.test`]) {
    assert.equal(connect(name), null);
  }
  assert.equal(calls.length, 1);
  for (const suffix of ['', 'localhost', 'relay.example.test/evil', '127.0.0.1']) assert.throws(() => createSharedRouteConnector({ suffix }));
});

test('shared enrollment stays compatible with the current secure desktop invitation', () => {
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const relay = { host: 'ssh.example.test', port: 2222, hostKey: key };
  const enrollment = { version: 1, installationId: id, requestedBackends: ['paseo'], sshPublicKey: key };
  const shared = { publicBaseUrl: 'https://relay.example.test:24443', relay };
  const bundle = createSharedRelayBundle({ enrollment, hosting: 'project-hosted', shared });
  const invitation = validateHostedResponse(bundle.invitation, enrollment);
  assert.equal(invitation.version, 3);
  assert.equal(invitation.publicBaseUrl, `https://${id}.relay.example.test:24443`);
  assert.equal(invitation.relay.port, 2222);
  assert.equal(invitation.relay.user, accountForInstallation(id));
  assert.equal(bundle.targetSocket, sharedSocket(id));
  assert.equal(bundle.authorizedKey, `restrict,port-forwarding ${key}\n`);
  const other = createSharedRelayBundle({ enrollment: { ...enrollment, installationId: randomUUID() }, hosting: 'project-hosted', shared });
  assert.equal(new URL(other.invitation.publicBaseUrl).port, new URL(invitation.publicBaseUrl).port);
  assert.equal(other.invitation.relay.port, invitation.relay.port);
  assert.notEqual(other.targetSocket, bundle.targetSocket);
  for (const publicBaseUrl of ['http://relay.example.test:24443', 'https://relay.example.test/path', 'https://127.0.0.1:24443']) {
    assert.throws(() => createSharedRelayBundle({ enrollment, hosting: 'project-hosted', shared: { ...shared, publicBaseUrl } }));
  }
});
