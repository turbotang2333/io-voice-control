import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import { prepareConnectorHome } from '../distribution/setup.mjs';

test('Codex installation stays detected when optional process inspection fails', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/connector-native'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'detection-')), resources = join(root, 'app/resources');
  mkdirSync(resources, { recursive: true }); writeFileSync(join(resources, 'codex.exe'), 'fixture');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = join(root, 'probe.ps1');
  writeFileSync(script, `\uFEFFfunction Get-AppxPackage { [pscustomobject]@{ InstallLocation=${quote(root)}; Version='1.0' } }\nfunction Get-CimInstance { throw 'access denied' }\nfunction Get-NetTCPConnection { @() }\n& ${quote(resolve('distribution/desktop-state.ps1'))}\n`);
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }));
  assert.equal(result.installed, true); assert.equal(result.inspectionFailed, true);
});

test('fresh Windows setup produces a usable local TLS certificate and desktop adapter without starting assistants',
  { skip: process.platform !== 'win32' }, async t => {
    const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/connector-native');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const privateDirectory = join(root, 'private');
    const result = await prepareConnectorHome({ privateDirectory, stateDirectory: join(root, 'state'),
      backends: ['paseo', 'codex'], executable: join(root, 'unlaunched-native.exe'),
      async generateCertificate({ directory, password }) {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('distribution/certificate.ps1'), '-Directory', directory],
          { env: { ...process.env, RAYNEO_INSTALL_PFX_PASSWORD: password }, windowsHide: true, timeout: 30000, stdio: 'pipe' });
      },
      async prepareDesktopAdapter(output) {
        execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
          ['/nologo', '/optimize+', '/target:exe', '/out:' + output, resolve('experiments/codex-shared/DesktopProxy.cs')],
          { windowsHide: true, timeout: 30000, stdio: 'pipe' });
      },
    });
    assert.equal(result.modelMessagesSent, 0); assert.equal(result.existingDesktopChanged, false);
    const publicKey = execFileSync('ssh-keygen.exe', ['-y', '-f', join(privateDirectory, 'relay-key.pem')],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: 'pipe' }).trim();
    assert.equal(publicKey, result.enrollment.sshPublicKey.split(' ').slice(0, 2).join(' '));
    const profile = JSON.parse(readFileSync(join(privateDirectory, 'shared-runtime/connector.json')));
    const certificate = new X509Certificate(readFileSync(join(privateDirectory, 'local.cer')));
    const marker = randomBytes(16).toString('hex');
    const server = createServer({ pfx: readFileSync(profile.pfxPath), passphrase: profile.password }, (_request, response) => response.end(marker));
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    t.after(() => new Promise(accept => { server.closeAllConnections(); server.close(accept); }));
    const response = await new Promise((accept, reject) => {
      const request = get({ hostname: '127.0.0.1', port: server.address().port, ca: certificate.toString(), timeout: 5000 }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => accept(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
      });
      request.on('error', reject); request.on('timeout', () => request.destroy(Error('TLS_PROBE_TIMEOUT')));
    });
    assert.equal(response, marker);
    assert.equal(readFileSync(join(privateDirectory, 'shared-runtime/rayneo-desktop-proxy.exe')).subarray(0, 2).toString(), 'MZ');
    assert.equal(certificate.checkHost('localhost'), 'localhost');
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  });
