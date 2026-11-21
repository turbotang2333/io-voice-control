import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), '.local-secrets', 'rayneo-paseo');
const configFile = join(root, 'local-test.json');
if (existsSync(configFile)) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  for (const name of ['server.p12', 'apk-signing.p12', 'local.cer']) if (!existsSync(join(root, name))) throw new Error('Local test credential set is incomplete');
  if (!config.apiToken || !config.password) throw new Error('Invalid local test configuration');
} else {
  mkdirSync(root, { recursive: true });
  for (const name of ['server.p12', 'apk-signing.p12']) if (existsSync(join(root, name))) throw new Error('Partial credential set exists; refusing to overwrite');
  const password = randomBytes(32).toString('hex');
  const env = { ...process.env, RAYNEO_PASEO_BUILD_PASSWORD: password };
  for (const [file, alias, extra] of [
    ['server.p12', 'local-tls', ['-ext', 'SAN=IP:127.0.0.1,DNS:localhost']],
    ['apk-signing.p12', 'local-apk', []],
  ]) {
    execFileSync('keytool', ['-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', join(root, file), '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '365', '-dname', 'CN=RayneoPaseoLocal', '-storepass:env', 'RAYNEO_PASEO_BUILD_PASSWORD', '-keypass:env', 'RAYNEO_PASEO_BUILD_PASSWORD', ...extra], { env, stdio: 'pipe' });
  }
  execFileSync('keytool', ['-exportcert', '-keystore', join(root, 'server.p12'), '-alias', 'local-tls', '-storepass:env', 'RAYNEO_PASEO_BUILD_PASSWORD', '-file', join(root, 'local.cer')], { env, stdio: 'pipe' });
  writeFileSync(configFile, JSON.stringify({ version: 1, password, apiToken: randomBytes(32).toString('hex'), port: 7467 }), { flag: 'wx', mode: 0o600 });
}
console.log('Local TLS and test signing credentials are ready in the private project configuration directory.');
