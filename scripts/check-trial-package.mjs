import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSecureContext } from 'node:tls';
import { verifyConnectorPackage } from '../distribution/integrity.mjs';

const [flag, bundle, ...extra] = process.argv.slice(2);
if (process.platform !== 'win32' || flag !== '--package-dir' || !isAbsolute(bundle ?? '') || extra.length) throw Error('USAGE');
const checked = await verifyConnectorPackage(bundle);
const app = join(bundle, 'app');
const { prepareConnectorHome, importTrialInvitation } = await import(pathToFileURL(join(app, 'distribution/setup.mjs')));
const parent = join(homedir(), '.local-secrets/rayneo-paseo/distribution-acceptance'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'fresh-'));
const stateParent = join(homedir(), '.local/state/rayneo-paseo/distribution-acceptance'); mkdirSync(stateParent, { recursive: true });
const stateDirectory = mkdtempSync(join(stateParent, 'fresh-')), privateDirectory = join(root, 'private');
const result = await prepareConnectorHome({ privateDirectory, stateDirectory, backends: ['paseo', 'codex'],
  executable: join(root, 'deliberately-unlaunched-native.exe'),
  async generateCertificate({ directory, password }) {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(app, 'distribution/certificate.ps1'), '-Directory', directory],
      { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, windowsHide: true, stdio: 'pipe', timeout: 30000 });
  },
  async prepareDesktopAdapter(output) {
    execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/optimize+', '/target:exe', '/out:' + output, join(app, 'experiments/codex-shared/DesktopProxy.cs')],
      { windowsHide: true, stdio: 'pipe', timeout: 30000 });
  },
});
const profile = JSON.parse(readFileSync(join(privateDirectory, 'shared-runtime/connector.json')));
createSecureContext({ pfx: readFileSync(profile.pfxPath), passphrase: profile.password });
const publicKey = execFileSync('ssh-keygen.exe', ['-y', '-f', join(privateDirectory, 'relay-key.pem')],
  { windowsHide: true, stdio: 'pipe', encoding: 'utf8', timeout: 10000 }).trim();
if (publicKey !== result.enrollment.sshPublicKey.split(' ').slice(0, 2).join(' ')) throw Error('SSH_PUBLIC_KEY_MISMATCH');
const invitation = { version: 1, installationId: result.enrollment.installationId,
  relay: { host: 'relay.example.test', port: 22, user: 'trial-user', hostKey: 'ssh-ed25519 ' + Buffer.concat([
    Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1),
  ]).toString('base64') },
  backends: { paseo: { endpoint: 'https://example.test/trial/paseo', remotePort: 28001 },
    codex: { endpoint: 'https://example.test/trial/codex', remotePort: 28002 } },
};
const imported = importTrialInvitation({ privateDirectory, invitation });
const receipt = { version: checked.version, packageIntegrityVerified: true, newPrivateProfilePrepared: true,
  certificateLoaded: true, desktopAdapterCompiled: true, sshKeyAcceptedByWindowsOpenSsh: true,
  syntheticInvitationImported: imported.wirelessConfigured, providerOrRelayStarted: false,
  modelMessagesSent: 0, secondPhysicalComputerTest: false };
writeFileSync(join(stateDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
