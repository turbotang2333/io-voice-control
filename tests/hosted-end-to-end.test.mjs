import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tlsFixture, listen } from './helpers/tls-fixture.mjs';
import { createHostedService } from '../relay/hosted-service.mjs';
import { createHostedProvider } from '../distribution/hosted-provider.mjs';
import { createSecureDashboardActions } from '../distribution/secure-actions.mjs';
import { createLinuxInstallDriver } from '../relay/install.mjs';

test('one computer action crosses a real local encrypted service and configures only its own hosted relay', async t => {
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const identity = tlsFixture('hosted-end-to-end'), parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/hosted-end-to-end'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), databasePath = join(root, 'registry.sqlite'); let starts = 0;
  for (const directory of ['etc/ssh', 'etc/systemd/system', 'var/lib']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'etc/ssh/ssh_host_ed25519_key.pub'), key + '\n');
  const run = (command, args) => {
    if (command === 'getent') throw Object.assign(Error(), { status: 2 });
    if (command === 'id') return '1001\n';
    if (command === 'sshd' && args[0] === '-T') {
      const directory = args[args.indexOf('-f') + 1].replace(/\/sshd_config$/, '');
      return `allowtcpforwarding remote\npermitlisten none\nallowstreamlocalforwarding remote\nstreamlocalbindunlink yes\nstreamlocalbindmask 0177\nchrootdirectory ${directory}\npermittty no\nmaxsessions 0\nauthorizedkeysfile ${directory}/authorized_keys\nauthenticationmethods publickey\npubkeyauthentication yes\npasswordauthentication no\nkbdinteractiveauthentication no\npermituserrc no\npermittunnel no\n`;
    }
    if (command === 'systemctl' && args[0] === 'show') {
      if (args.includes('--property=FragmentPath')) return '/etc/systemd/system/' + args.at(-1) + '\n';
      if (args.includes('--property=NeedDaemonReload')) return 'no\n';
      return 'not-found\n';
    }
    if (command === 'systemctl' && args[0] === 'enable' && args.at(-1).startsWith('rayneo-relay-')) starts++;
    return '';
  };
  const serverSource = fileURLToPath(new URL('../relay/server.mjs', import.meta.url));
  const driverFactory = () => createLinuxInstallDriver({ root, serverSource, run,
    platform: 'linux', uid: 0, strictOwners: false, probePort: async () => true, chownPath: () => {} });
  const runtime = await createHostedService({ databasePath, nodePath: '/usr/bin/node', driverFactory,
    tls: { pfx: identity.pfx, passphrase: identity.passphrase },
    slots: [{ id: 'one', publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } }] });
  t.after(() => runtime.close()); const port = await listen(runtime.server);
  const fetchImpl = async (url, options) => await new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({ host: '127.0.0.1', servername: target.hostname, port, path: target.pathname, method: options.method,
      headers: options.headers, ca: identity.cert, signal: options.signal }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(options.body);
  });
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key, apiToken: 'synthetic-private-token' };
  let state = 'unconfigured', configured, connects = 0;
  const legacy = { async connect(options) { assert.equal(options.invitationCode, undefined); return { needsConfiguration: true }; }, enrollment() { return enrollment; } };
  const secure = { async status() { return { phase: state }; }, async configure(value) { configured = value; state = 'configured'; }, async connect(options) { assert.equal(options.invitationCode, undefined); connects++; return { starting: true }; } };
  const actions = createSecureDashboardActions({ legacy, secure, hostedRequest: createHostedProvider({ serviceUrl: 'https://relay.example.test/v1/enroll', fetchImpl }) });
  assert.equal((await actions.connect({ hosting: 'project-hosted', invitationCode: 'rnp-' + 'A'.repeat(43) })).starting, true);
  assert.equal(configured.installationId, enrollment.installationId); assert.equal(configured.hosting, 'project-hosted');
  assert.equal(existsSync(join(root, 'var/lib/rayneo-relay', enrollment.installationId, 'relay.json')), true);
  assert.ok(!JSON.stringify(configured).includes(enrollment.apiToken)); assert.equal(starts, 1); assert.equal(connects, 1);
  await actions.connect({ hosting: 'project-hosted' }); assert.equal(starts, 1); assert.equal(connects, 2);
});
