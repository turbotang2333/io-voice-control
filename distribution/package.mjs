import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, mkdir, mkdtemp, copyFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { searchDependencyPaths } from './search-dependencies.mjs';

export const connectorVersion = '0.2.0-trial.1';
const fail = code => Object.assign(Error(code), { code });
const scripts = new Set(['run-daily.ps1', 'run-codex-daily.ps1', 'assistant-connection.ps1',
  'check-assistant-connection.mjs', 'start-codex-shared.ps1', 'set-codex-startup.ps1', 'prepare-codex-startup.ps1', 'resolve-node.ps1']);
const runtimeRoots = ['bridge', 'experiments/codex-direct', 'experiments/codex-connector', 'experiments/codex-shared', 'secure-link', 'relay'];
const normalizedDependencies = object => JSON.stringify(Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b)));
async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

/** Explicit runtime roots only. Never traverse user configuration, build output, model caches or histories. */
export async function buildConnectorPackage({ source, output, runtime, runtimeLicense, trayExecutable } = {}) {
  if (![source, output, runtime, runtimeLicense].every(p => typeof p === 'string' && isAbsolute(p))) throw fail('PACKAGE_PATH_INVALID');
  source = resolve(source); output = resolve(output);
  if (output === source || !relative(source, output).startsWith('..')) throw fail('PACKAGE_OUTPUT_IN_SOURCE');
  if (await exists(output)) throw fail('PACKAGE_OUTPUT_EXISTS');
  const packageFile = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
  if (normalizedDependencies(packageFile.dependencies) !== normalizedDependencies(lock.packages?.['']?.dependencies)) throw fail('PACKAGE_LOCK_MISMATCH');
  const paseoLicense = join(source, 'distribution/PASEO-LICENSE.txt');
  let paseoLicenseStat;
  try { paseoLicenseStat = await lstat(paseoLicense); } catch { throw fail('PACKAGE_PASEO_LICENSE_MISSING'); }
  if (!paseoLicenseStat.isFile() || paseoLicenseStat.isSymbolicLink() || !paseoLicenseStat.size) throw fail('PACKAGE_PASEO_LICENSE_MISSING');
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    let stat;
    try { stat = await lstat(join(source, name)); } catch { throw fail('PACKAGE_PROJECT_LICENSE_MISSING'); }
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw fail('PACKAGE_PROJECT_LICENSE_MISSING');
  }
  for (const p of [runtime, runtimeLicense]) if (!(await lstat(p)).isFile() || (await lstat(p)).isSymbolicLink()) throw fail('PACKAGE_RUNTIME_INVALID');
  let trayStaging, uninstallStaging, uninstallExecutable;
  const traySource = join(source, 'distribution/Tray.cs');
  if (trayExecutable === undefined && await exists(traySource)) {
    const stat = await lstat(traySource);
    if (process.platform !== 'win32' || !stat.isFile() || stat.isSymbolicLink()) throw fail('PACKAGE_RUNTIME_INVALID');
    trayStaging = await mkdtemp(join(dirname(output), '.connector-tray-'));
    trayExecutable = join(trayStaging, 'tray.exe');
    const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    try { execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/out:' + trayExecutable,
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', traySource],
      { windowsHide: true, stdio: 'pipe', timeout: 30000 }); }
    catch { throw fail('PACKAGE_TRAY_BUILD_FAILED'); }
  }
  if (trayExecutable !== undefined && (!isAbsolute(trayExecutable) || !(await lstat(trayExecutable)).isFile() || (await lstat(trayExecutable)).isSymbolicLink())) throw fail('PACKAGE_RUNTIME_INVALID');
  const uninstallerSource = join(source, 'distribution/Uninstaller.cs');
  if (await exists(uninstallerSource)) {
    if (process.platform !== 'win32') throw fail('PACKAGE_RUNTIME_INVALID');
    uninstallStaging = await mkdtemp(join(dirname(output), '.connector-uninstall-'));
    uninstallExecutable = join(uninstallStaging, 'uninstall.exe');
    const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    try { execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/out:' + uninstallExecutable,
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', uninstallerSource], { windowsHide: true, stdio: 'pipe', timeout: 30000 }); }
    catch { throw fail('PACKAGE_UNINSTALL_BUILD_FAILED'); }
  }
  const files = [];
  const add = (from, path) => files.push({ from, path });
  async function collect(root, destination, accepts) {
    if (!await exists(root)) return;
    async function walk(directory, prefix = '') {
      for (const name of (await readdir(directory)).sort()) {
        if (name.startsWith('.')) continue;
        const file = join(directory, name), part = prefix ? prefix + '/' + name : name;
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) throw fail('PACKAGE_LINK_REJECTED');
        if (stat.isDirectory()) await walk(file, part);
        else if (stat.isFile() && accepts(part)) add(file, destination + '/' + part);
      }
    }
    const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('PACKAGE_LINK_REJECTED');
    await walk(root);
  }
  const code = name => name.endsWith('.mjs') && !/\.(test|fixture)\.mjs$/.test(name) && !/(?:^|\/)(?:desktop-check|transport-check)\.mjs$/.test(name);
  for (const directory of runtimeRoots) await collect(join(source, directory), 'app/' + directory,
    name => code(name) || directory === 'relay' && name === 'self-hosted-runtime.py');
  if (await exists(join(source, 'experiments/codex-shared/DesktopProxy.cs'))) add(join(source, 'experiments/codex-shared/DesktopProxy.cs'), 'app/experiments/codex-shared/DesktopProxy.cs');
  await collect(join(source, 'scripts'), 'app/scripts', name => scripts.has(name));
  await collect(join(source, 'distribution'), 'app/distribution', name => (/\.(mjs|ps1|html|js|css)$/.test(name) || name === 'search-package-config.json' || name === 'PASEO-LICENSE.txt') && !/(?:^|\/)(?:package|build)\.mjs$/.test(name) && !name.endsWith('.test.mjs'));
  const optionalSearch = [...searchDependencyPaths(lock)];
  await collect(join(source, 'node_modules'), 'app/node_modules', name =>
    !optionalSearch.some(path => ('node_modules/' + name).startsWith(path + '/')));
  for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) add(join(source, name), 'app/' + name);
  if (uninstallExecutable) add(uninstallExecutable, 'app/distribution/uninstall.exe');
  add(join(source, 'distribution/Setup.cmd'), 'Setup.cmd');
  add(runtime, 'runtime/node.exe'); add(runtimeLicense, 'runtime/LICENSE');
  if (trayExecutable) add(trayExecutable, '眼镜连接器.exe');
  for (const required of ['app/bridge/server.mjs', 'app/distribution/connector.mjs']) if (!files.some(f => f.path === required)) throw fail('PACKAGE_ENTRY_MISSING');
  // Validate the full selection before creating output. A partial build is never a release.
  for (const file of files) {
    const stat = await lstat(file.from);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('PACKAGE_LINK_REJECTED');
    file.bytes = stat.size;
    file.sha256 = await fingerprint(file.from);
  }
  await mkdir(output, { recursive: false });
  const manifest = { format: 1, version: connectorVersion, platform: 'win32', architecture: process.arch,
    createdAt: new Date().toISOString(), files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  for (const file of files) {
    const target = join(output, file.path); await mkdir(dirname(target), { recursive: true });
    await copyFile(file.from, target);
    if (await fingerprint(target) !== file.sha256) throw fail('PACKAGE_SOURCE_CHANGED');
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  if (trayStaging) { await unlink(trayExecutable); await rmdir(trayStaging); }
  if (uninstallStaging) { await unlink(uninstallExecutable); await rmdir(uninstallStaging); }
  return { version: connectorVersion, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    personalConfigurationIncluded: false, credentialsIncluded: false, modelMessagesSent: 0, installed: false };
}
