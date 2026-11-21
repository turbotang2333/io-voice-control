import { randomBytes, randomUUID, generateKeyPairSync, createHash, X509Certificate, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fail = code => Object.assign(Error(code), { code });
const secret = () => randomBytes(32).toString('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value, fresh = false) => {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (fresh) { writeFileSync(path, content, { flag: 'wx', mode: 0o600 }); return; }
  const temporary = path + '-' + randomBytes(8).toString('hex') + '.tmp';
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path);
};
function sshString(value) { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); }
function mpint(value) { const bytes = Buffer.from(value, 'base64url'); return sshString(bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes); }
function publicSshKey(key) {
  const jwk = key.export({ format: 'jwk' });
  return 'ssh-rsa ' + Buffer.concat([sshString(Buffer.from('ssh-rsa')), mpint(jwk.e), mpint(jwk.n)]).toString('base64') + ' rayneo-trial';
}
const validBackends = values => Array.isArray(values) && values.length > 0 && values.length <= 2
  && new Set(values).size === values.length && values.every(v => ['paseo', 'codex'].includes(v));

function publicEnrollment(installation, certificate, publicKey) {
  return { version: 1, installationId: installation.installationId, requestedBackends: [...installation.backends], sshPublicKey: publicSshKey(publicKey),
    certificatePem: certificate.toString(), certificateSha256: createHash('sha256').update(certificate.raw).digest('hex'),
    platform: 'win32', architecture: process.arch };
}

/** Creates a new user's private configuration only. It never imports the developer's settings or starts a provider. */
export async function prepareConnectorHome({ privateDirectory, stateDirectory, backends, executable,
  generateCertificate, prepareDesktopAdapter, independentCodex = false } = {}) {
  if (![privateDirectory, stateDirectory].every(v => isAbsolute(v ?? '')) || !validBackends(backends)
    || typeof generateCertificate !== 'function' || (backends.includes('codex') && !independentCodex && (!isAbsolute(executable ?? '') || typeof prepareDesktopAdapter !== 'function'))) throw fail('CONNECTOR_SETUP_INVALID');
  if (existsSync(join(privateDirectory, 'installation.json'))) {
    const installation = read(join(privateDirectory, 'installation.json'));
    if (installation.version === 1 && installation.phase === 'awaiting-invitation'
      && validBackends(installation.backends) && backends.length === installation.backends.length
      && backends.every(b => installation.backends.includes(b)) && /^[a-f0-9-]{36}$/.test(installation.installationId)
      && !existsSync(join(stateDirectory, 'enrollment-request.json'))) {
      const certificate = new X509Certificate(readFileSync(join(privateDirectory, 'local.cer')));
      const publicKey = createPublicKey(readFileSync(join(privateDirectory, 'relay-key.pem')));
      const enrollment = publicEnrollment(installation, certificate, publicKey);
      mkdirSync(stateDirectory, { recursive: true }); write(join(stateDirectory, 'enrollment-request.json'), enrollment, true);
      return { enrollment, configuredForWireless: false, existingDesktopChanged: false, modelMessagesSent: 0 };
    }
    throw fail('CONNECTOR_ALREADY_PREPARED');
  }
  if (existsSync(privateDirectory) && readdirSync(privateDirectory).length) throw fail('CONNECTOR_EXISTING_CONFIGURATION');
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 }); mkdirSync(stateDirectory, { recursive: true });
  if (existsSync(join(stateDirectory, 'enrollment-request.json'))) throw fail('CONNECTOR_EXISTING_CONFIGURATION');
  if (process.platform === 'win32') {
    try {
      execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./protect-directory.ps1', import.meta.url)), '-Directory', privateDirectory],
        { windowsHide: true, timeout: 10000, stdio: 'pipe' });
    } catch { throw fail('CONNECTOR_PRIVACY_FAILED'); }
  }
  const installationId = randomUUID(), password = secret();
  const staging = join(privateDirectory, '.setup-' + installationId);
  mkdirSync(staging, { mode: 0o700 });
  const staged = name => join(staging, name);
  try {
  const installation = { version: 1, installationId, backends: [...backends], phase: 'preparing', createdAt: new Date().toISOString() };
  write(staged('installation.json'), installation, true);
  const pfxPath = join(privateDirectory, 'server.p12'), certificatePath = join(privateDirectory, 'local.cer');
  await generateCertificate({ directory: staging, pfxPath: staged('server.p12'), certificatePath: staged('local.cer'), password });
  const certificate = new X509Certificate(readFileSync(staged('local.cer')));
  if (certificate.checkHost('localhost') !== 'localhost' || certificate.checkIP('127.0.0.1') !== '127.0.0.1') throw fail('CONNECTOR_CERTIFICATE_INVALID');
  const key = generateKeyPairSync('rsa', { modulusLength: 3072 });
  writeFileSync(staged('relay-key.pem'), key.privateKey.export({ type: 'pkcs1', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  write(staged('local-test.json'), { version: 1, password, apiToken: secret(), port: 7467 }, true);
  if (backends.includes('paseo')) {
    write(staged('daily.json'), { version: 1, port: 7468, apiToken: secret() }, true);
    write(staged('relay.json'), { version: 1, enabled: false }, true);
  }
  if (backends.includes('codex')) {
    const shared = join(privateDirectory, 'shared-runtime'), stagedShared = staged('shared-runtime'); mkdirSync(stagedShared, { mode: 0o700 });
    if (independentCodex) {
      write(join(stagedShared, 'connector.json'), { host: '127.0.0.1', port: 19469, token: secret(), pfxPath, password,
        navigation: true, creation: true }, true);
    } else {
    const tokenFile = join(shared, 'capability.token'); writeFileSync(join(stagedShared, 'capability.token'), secret(), { flag: 'wx', mode: 0o600 });
    const connection = { endpoint: 'ws://127.0.0.1:19569/rpc', tokenFile };
    const desktopConfiguration = join(shared, 'desktop.json'), connectorConfiguration = join(shared, 'connector.json');
    const adapter = join(shared, 'rayneo-desktop-proxy.exe'); await prepareDesktopAdapter(join(stagedShared, 'rayneo-desktop-proxy.exe'));
    write(join(stagedShared, 'desktop.json'), { executable, connection }, true);
    write(join(stagedShared, 'connector.json'), { host: '127.0.0.1', port: 19469, token: secret(), pfxPath, password,
      executable, navigation: true, creation: true, sharedConnection: connection }, true);
    write(join(stagedShared, 'startup.json'), { version: 1, adapter, desktopConfiguration, connectorConfiguration,
      wirelessConfiguration: join(shared, 'connector-wireless.json') }, true);
    }
  }
  const enrollment = publicEnrollment(installation, certificate, key.publicKey);
  write(staged('installation.json'), { ...installation, phase: 'awaiting-invitation' });
  // No configuration becomes visible until all platform preparation has succeeded.
  const names = readdirSync(staging).filter(name => name !== 'installation.json');
  for (const name of [...names, 'installation.json']) {
    if (existsSync(join(privateDirectory, name))) throw fail('CONNECTOR_EXISTING_CONFIGURATION');
  }
  for (const name of [...names, 'installation.json']) renameSync(staged(name), join(privateDirectory, name));
  write(join(stateDirectory, 'enrollment-request.json'), enrollment, true);
  return { enrollment, configuredForWireless: false, existingDesktopChanged: false, modelMessagesSent: 0 };
  } finally {
    // Only this invocation's newly created staging directory is eligible for cleanup.
    const absoluteRoot = realpathSync(privateDirectory), absoluteStage = resolve(staging);
    if (existsSync(staging) && !lstatSync(staging).isSymbolicLink()
      && absoluteStage.startsWith(resolve(privateDirectory) + sep)
      && realpathSync(staging).startsWith(absoluteRoot + sep)) rmSync(staging, { recursive: true });
  }
}

function validateInvitation(value, installation) {
  if (!value || value.version !== 1 || value.installationId !== installation.installationId
    || !value.backends || !validBackends(Object.keys(value.backends)) || !value.relay) throw fail('CONNECTOR_INVITATION_INVALID');
  const relay = value.relay;
  if (typeof relay.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(relay.host)
    || !Number.isInteger(relay.port) || relay.port < 1 || relay.port > 65535 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(relay.user ?? '')
    || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(relay.hostKey ?? '')) throw fail('CONNECTOR_INVITATION_INVALID');
  const publicKey = Buffer.from(relay.hostKey.split(' ')[1], 'base64');
  if (publicKey.length !== 51 || publicKey.readUInt32BE(0) !== 11 || publicKey.subarray(4, 15).toString() !== 'ssh-ed25519'
    || publicKey.readUInt32BE(15) !== 32) throw fail('CONNECTOR_INVITATION_INVALID');
  const ports = new Set(), result = {};
  for (const [backend, profile] of Object.entries(value.backends)) {
    if (!installation.backends.includes(backend) || !Number.isInteger(profile?.remotePort) || profile.remotePort < 20000 || profile.remotePort > 60000
      || ports.has(profile.remotePort) || typeof profile.endpoint !== 'string') throw fail('CONNECTOR_INVITATION_INVALID');
    let url; try { url = new URL(profile.endpoint); } catch { throw fail('CONNECTOR_INVITATION_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^[A-Za-z0-9/_-]*$/.test(url.pathname)
      || url.pathname.includes('//')) throw fail('CONNECTOR_INVITATION_INVALID');
    ports.add(profile.remotePort); result[backend] = { endpoint: url.href.replace(/\/+$/, ''), remotePort: profile.remotePort };
  }
  return { relay, backends: result };
}

/** Imports an operator's per-user public invitation. No shared private SSH credential is distributed. */
export function importTrialInvitation({ privateDirectory, invitation } = {}) {
  if (!isAbsolute(privateDirectory ?? '') || !existsSync(join(privateDirectory, 'installation.json'))) throw fail('CONNECTOR_SETUP_INVALID');
  const installation = read(join(privateDirectory, 'installation.json'));
  const safe = validateInvitation(invitation, installation);
  const digest = createHash('sha256').update(JSON.stringify(invitation)).digest('hex');
  if (installation.invitationHash && installation.invitationHash !== digest) throw fail('CONNECTOR_INVITATION_ALREADY_IMPORTED');
  const sshConfigPath = join(privateDirectory, 'ssh-config'), knownHosts = join(privateDirectory, 'known-hosts');
  const alias = 'rayneo-trial-' + installation.installationId;
  const quote = value => '"' + value.replaceAll('\\', '/').replaceAll('"', '') + '"';
  if (![privateDirectory, sshConfigPath, knownHosts].every(p => !/[\r\n\0"]/.test(p))) throw fail('CONNECTOR_SETUP_INVALID');
  writeFileSync(knownHosts, 'rayneo-trial-relay ' + safe.relay.hostKey + '\n', { mode: 0o600 });
  writeFileSync(sshConfigPath, `Host ${alias}\n  HostName ${safe.relay.host}\n  Port ${safe.relay.port}\n  User ${safe.relay.user}\n  IdentityFile ${quote(join(privateDirectory, 'relay-key.pem'))}\n  IdentitiesOnly yes\n  HostKeyAlias rayneo-trial-relay\n  UserKnownHostsFile ${quote(knownHosts)}\n  StrictHostKeyChecking yes\n  BatchMode yes\n`, { mode: 0o600 });
  if (safe.backends.paseo) {
    const file = join(privateDirectory, 'daily.json'), daily = read(file);
    write(file, { ...daily, publicBaseUrl: safe.backends.paseo.endpoint });
    write(join(privateDirectory, 'relay.json'), { version: 1, enabled: true, sshHost: alias, sshConfigPath, remotePort: safe.backends.paseo.remotePort });
  }
  if (safe.backends.codex) {
    const shared = join(privateDirectory, 'shared-runtime');
    write(join(shared, 'connector-wireless.json'), { endpoint: safe.backends.codex.endpoint, localPort: 19469,
      remoteLoopbackPort: safe.backends.codex.remotePort, configPath: join(shared, 'connector.json'), sshHost: alias, sshConfigPath });
  }
  const hostingBackend = safe.backends.paseo ? 'paseo' : 'codex';
  write(join(privateDirectory, 'pairing-config.json'), { version: 1, hostingBackend });
  write(join(privateDirectory, 'installation.json'), { ...installation, phase: 'configured', invitationHash: digest,
    configuredBackends: Object.keys(safe.backends), invitationImportedAt: new Date().toISOString() });
  return { wirelessConfigured: true, serverChanged: false, modelMessagesSent: 0 };
}
