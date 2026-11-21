import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('operator wizard emits relay files and a public invitation without installing or touching a service', () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/relay-wizard'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), output = join(root, 'bundle');
  const hostKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  writeFileSync(join(root, 'request.json'), JSON.stringify({ version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: hostKey }));
  writeFileSync(join(root, 'answers.json'), JSON.stringify({ hosting: 'project-hosted', publicBaseUrl: 'https://relay.example.test:24443', remotePort: 28001,
    relay: { host: 'relay.example.test', port: 22, user: 'rayneo_test', hostKey } }));
  const args = ['relay/wizard.mjs', '--request', join(root, 'request.json'), '--answers', join(root, 'answers.json'), '--output', output];
  const receipt = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' }));
  assert.equal(receipt.installed, false); assert.equal(receipt.serverChanged, false); assert.equal(receipt.modelMessagesSent, 0);
  const invite = JSON.parse(readFileSync(join(output, 'invitation.json')));
  assert.equal(invite.version, 3); assert.equal(invite.hosting, 'project-hosted');
  assert.equal(invite.remoteSocket, '/tunnel/relay.sock');
  assert.equal(JSON.parse(readFileSync(join(output, 'relay.json'))).targetSocket, `/var/lib/rayneo-relay/${invite.installationId}/tunnel/relay.sock`);
  assert.deepEqual(readdirSync(output).sort(), ['authorized-key', 'invitation.json', 'relay', 'relay-server.mjs', 'relay.json', 'run.sh', 'secure-link', 'sshd.conf']);
  const help = execFileSync(process.execPath, [join(output, 'relay/install.mjs'), '--help'], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(help, /--check/); assert.match(help, /--install/); assert.match(help, /--status/);
  assert.doesNotMatch(help, /暂未开放/);
  const wizardHelp = execFileSync(process.execPath, ['relay/wizard.mjs', '--help'], { encoding: 'utf8', stdio: 'pipe' });
  assert.doesNotMatch(wizardHelp, /暂未开放/);
  if (process.platform !== 'linux') assert.throws(() => execFileSync(process.execPath, [join(output, 'relay/install.mjs'), '--check'], { stdio: 'pipe' }),
    error => error.status === 1 && /RELAY_ROOT_REQUIRED/.test(error.stderr.toString()));
  // Exercise the emitted executable's input validation, not just the presence of source text.
  const badConfig = join(root, 'bad.json'); writeFileSync(badConfig, '{"version":1,"listenPort":24443,"targetPort":0}');
  assert.throws(() => execFileSync(process.execPath, [join(output, 'relay-server.mjs'), '--config', badConfig], { stdio: 'pipe' }), error => error.status === 1 && error.stderr.toString().includes('RELAY_CONFIG_INVALID'));
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  assert.equal(JSON.parse(readFileSync(join(output, 'invitation.json'))).installationId, invite.installationId);
});
