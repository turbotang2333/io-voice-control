import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Disposable test identities only. No developer/user key material is read.
export function tlsFixture(label = 'tls', { extraDnsNames = [] } = {}) {
  if (!Array.isArray(extraDnsNames) || extraDnsNames.some(name => !/^[a-z0-9.-]+$/.test(name))) throw Error('invalid fixture hostname');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts', label);
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'fixture-')), passphrase = randomBytes(32).toString('hex');
  execFileSync('keytool', ['-genkeypair', '-alias', 'desktop', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2',
    '-dname', 'CN=localhost', '-ext', 'SAN=dns:localhost,ip:127.0.0.1,ip:127.0.0.2,dns:relay.example.test' + extraDnsNames.map(name => ',dns:' + name).join(''), '-ext', 'EKU=serverAuth',
    '-storetype', 'PKCS12', '-keystore', join(directory, 'server.p12'), '-storepass', passphrase, '-noprompt'], { stdio: 'pipe' });
  execFileSync('keytool', ['-exportcert', '-alias', 'desktop', '-rfc', '-keystore', join(directory, 'server.p12'),
    '-storepass', passphrase, '-file', join(directory, 'certificate.pem')], { stdio: 'pipe' });
  const cert = readFileSync(join(directory, 'certificate.pem'));
  return { directory, pfx: readFileSync(join(directory, 'server.p12')), passphrase, cert,
    certificateSha256: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex') };
}

export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
export async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
