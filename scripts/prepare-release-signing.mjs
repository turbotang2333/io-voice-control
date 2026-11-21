import { randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fail = code => Object.assign(Error(code), { code });
const protectScript = fileURLToPath(new URL('../distribution/protect-directory.ps1', import.meta.url));
const defaultDirectory = join(homedir(), '.local-secrets', 'rayneo-paseo', 'release-signing');
const aclCheck = `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:RAYNEO_RELEASE_SIGNING_DIRECTORY; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; if(!$a.AreAccessRulesProtected -or $a.Owner -ne $u.Translate([Security.Principal.NTAccount]).Value){exit 1}; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow'){ $s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($s -notin @($u.Value,'S-1-5-18')){exit 1}}}`;

function checkDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('RELEASE_SIGNING_UNSAFE');
  if (process.platform === 'win32') {
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', aclCheck], {
      env: { ...process.env, RAYNEO_RELEASE_SIGNING_DIRECTORY: directory }, windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
    catch { throw fail('RELEASE_SIGNING_UNSAFE'); }
  } else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid()) throw fail('RELEASE_SIGNING_UNSAFE');
}

function validate(directory) {
  try {
    checkDirectory(directory);
    const key = join(directory, 'signing.p12'), settings = join(directory, 'settings.json');
    for (const file of [key, settings]) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size) throw Error();
    }
    const config = JSON.parse(readFileSync(settings, 'utf8'));
    if (config.version !== 1 || config.alias !== 'rayneo-release' || !/^[a-f0-9]{64}$/.test(config.password ?? '')) throw Error();
    const cert = execFileSync('keytool', ['-exportcert', '-keystore', key, '-alias', config.alias,
      '-storepass:env', 'RAYNEO_RELEASE_SIGNING_PASSWORD'], { env: { ...process.env, RAYNEO_RELEASE_SIGNING_PASSWORD: config.password },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    const identity = new X509Certificate(cert), expiresAt = new Date(identity.validTo).toISOString();
    if (Date.parse(expiresAt) <= Date.now() || Date.parse(identity.validTo) - Date.parse(identity.validFrom) < 25 * 365 * 86400000) throw Error();
    return { expiresAt };
  } catch (error) { if (error.code === 'RELEASE_SIGNING_UNSAFE') throw error; throw fail('RELEASE_SIGNING_INCOMPLETE'); }
}

/** Read-only preflight for builds: an absent or incomplete identity must never be generated implicitly. */
export async function inspectReleaseSigning({ directory = defaultDirectory } = {}) {
  if (!isAbsolute(directory ?? '') || /[\r\n\0]/.test(directory)) throw fail('RELEASE_SIGNING_INVALID');
  if (!existsSync(directory)) throw fail('RELEASE_SIGNING_INCOMPLETE');
  return validate(resolve(directory));
}

/** Creates a separate release identity once. Partial state is retained for inspection, never overwritten. */
export async function prepareReleaseSigning({ directory = defaultDirectory } = {}) {
  if (!isAbsolute(directory ?? '') || /[\r\n\0]/.test(directory)) throw fail('RELEASE_SIGNING_INVALID');
  directory = resolve(directory);
  if (existsSync(directory)) return { created: false, ...validate(directory) };
  mkdirSync(directory, { mode: 0o700 });
  if (process.platform === 'win32') {
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', protectScript, '-Directory', directory],
      { windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
    catch { throw fail('RELEASE_SIGNING_UNSAFE'); }
  }
  checkDirectory(directory);
  const password = randomBytes(32).toString('hex'), alias = 'rayneo-release';
  try {
    execFileSync('keytool', ['-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', join(directory, 'signing.p12'),
      '-alias', alias, '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10958', '-dname', 'CN=RayneoPaseoRelease',
      '-storepass:env', 'RAYNEO_RELEASE_SIGNING_PASSWORD', '-keypass:env', 'RAYNEO_RELEASE_SIGNING_PASSWORD'],
      { env: { ...process.env, RAYNEO_RELEASE_SIGNING_PASSWORD: password }, windowsHide: true, stdio: 'pipe', timeout: 60000 });
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ version: 1, alias, password }) + '\n', { flag: 'wx', mode: 0o600 });
    return { created: true, ...validate(directory) };
  } catch (error) { if (error.code === 'RELEASE_SIGNING_UNSAFE') throw error; throw fail('RELEASE_SIGNING_INCOMPLETE'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 3 || process.argv.length === 3 && process.argv[2] !== '--check') { process.stderr.write('RELEASE_SIGNING_INVALID\n'); process.exitCode = 1; }
  else (process.argv[2] === '--check' ? inspectReleaseSigning() : prepareReleaseSigning()).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write((error.code || 'RELEASE_SIGNING_FAILED') + '\n'); process.exitCode = 1;
  });
}
