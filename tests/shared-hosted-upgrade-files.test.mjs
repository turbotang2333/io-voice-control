import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createSharedInfrastructurePlan } from '../relay/shared-infrastructure.mjs';
import { createSharedHostedUpgradePlan } from '../relay/shared-hosted-upgrade-plan.mjs';
import { prepareSharedUpgradeFiles, openSharedUpgradeFiles } from '../relay/shared-hosted-upgrade-files.mjs';
import { createSharedHostedUpgradeDriver, recoverSharedHostedUpgrade } from '../relay/shared-hosted-upgrade-driver.mjs';
import { executeSharedHostedUpgrade } from '../relay/shared-hosted-upgrade-transaction.mjs';
import { checkUpgradeStartup } from '../relay/shared-hosted-upgrade-guard.mjs';
import { loadSharedHostedUpgradePlan } from '../relay/shared-hosted-upgrade-load.mjs';
import { acquireSharedUpgradeStartupLock } from '../relay/shared-hosted-upgrade-lock.mjs';

const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const config = { version: 1, listenHost: '127.0.0.1', listenPort: 28445, databasePath: '/var/lib/rayneo-paseo-shared-hosted/registry.sqlite',
  tlsKeyPath: '/etc/example/key.pem', tlsCertPath: '/etc/example/cert.pem', maxAllocations: 5000,
  shared: { publicBaseUrl: 'https://relay.example.test:24443', relay: { host: 'ssh.example.test', port: 2222, hostKey: key } },
  infrastructure: { publicPort: 24443, sshPort: 2222, suffix: 'relay.example.test', nodePath: '/usr/bin/node', listenHost: '127.0.0.1' } };
const additions = new Set(['/opt/rayneo-paseo-shared/relay/invite-store.mjs', '/opt/rayneo-paseo-shared/relay/invite-admin.mjs']);

function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/upgrade-files'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), local = path => join(root, path.replace(/^\/+/, ''));
  writeFileSync(join(root, '.rayneo-upgrade-test-only'), 'synthetic');
  const files = createSharedInfrastructurePlan(config.infrastructure).sourceFiles, currentSources = {}, candidateSources = {};
  for (const path of files) {
    const value = Buffer.from('old:' + path); currentSources[path] = additions.has(path) ? null : value;
    candidateSources[path] = additions.has(path) ? Buffer.from('new:' + path) : value;
    if (!additions.has(path)) { mkdirSync(dirname(local(path)), { recursive: true }); writeFileSync(local(path), value); }
  }
  candidateSources['/opt/rayneo-paseo-shared/relay/shared-hosted-runtime.mjs'] = Buffer.from('new-runtime');
  const text = JSON.stringify(config, null, 2) + '\n', configPath = '/etc/rayneo-paseo-shared/hosted.json';
  mkdirSync(dirname(local(configPath)), { recursive: true }); writeFileSync(local(configPath), text);
  const state = '/var/lib/rayneo-paseo-shared-hosted'; mkdirSync(local(state), { recursive: true });
  writeFileSync(local(state + '/registry.sqlite'), 'original-registration');
  const lock = new DatabaseSync(local(state + '/upgrade-startup-lock.sqlite')); lock.exec('CREATE TABLE guard (id INTEGER)'); lock.close();
  chmodSync(local(state + '/upgrade-startup-lock.sqlite'), 0o600);
  return { root, local, text, configPath, candidateSources, plan: createSharedHostedUpgradePlan({ currentConfigText: text, currentSources, candidateSources }) };
}

test('durable backup allows recovery after a partially applied upgrade', () => {
  const f = fixture(), prepared = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
  prepared.replaceSource(0); prepared.replaceSource(1);
  const recovered = openSharedUpgradeFiles({ root: f.root }); recovered.restore();
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
  for (const change of f.plan.sourceChanges) {
    if (change.beforeSha256 === null) assert.equal(existsSync(f.local(change.path)), false);
    else assert.match(readFileSync(f.local(change.path), 'utf8'), /^old:/);
  }
  assert.equal(readFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'), 'utf8'), 'original-registration');
});

test('config cannot switch before all source replacements are verified', () => {
  const f = fixture(), prepared = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
  assert.throws(() => prepared.replaceConfig(), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
});

test('changed target or backup prevents any automatic restore', () => {
  for (const tamper of ['target', 'backup']) {
    const f = fixture(), prepared = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
    const first = f.plan.sourceChanges[0]; prepared.replaceSource(0);
    if (tamper === 'target') writeFileSync(f.local(first.path), 'external-change');
    else writeFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup/before-config'), 'damaged');
    const configBefore = readFileSync(f.local(f.configPath));
    assert.throws(() => openSharedUpgradeFiles({ root: f.root }).restore(), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
    assert.deepEqual(readFileSync(f.local(f.configPath)), configBefore);
  }
});

test('restore retains the original file permissions', { skip: process.platform === 'win32' }, () => {
  const f = fixture(), target = f.plan.sourceChanges.find(x => x.beforeSha256 !== null);
  chmodSync(f.local(target.path), 0o600);
  const prepared = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
  prepared.replaceSource(f.plan.sourceChanges.indexOf(target));
  openSharedUpgradeFiles({ root: f.root }).restore();
  assert.equal(statSync(f.local(target.path)).mode & 0o777, 0o600);
});

test('a plan without both invitation files cannot change the service configuration', () => {
  const f = fixture();
  const tampered = { ...f.plan, sourceChanges: f.plan.sourceChanges.filter(x => x.beforeSha256 !== null) };
  assert.throws(() => prepareSharedUpgradeFiles({ root: f.root, plan: tampered }), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
});

test('a changed related file blocks both backup and configuration switch', () => {
  const unchanged = '/opt/rayneo-paseo-shared/relay/shared-router.mjs';
  const f = fixture(); writeFileSync(f.local(unchanged), 'outside-change');
  assert.throws(() => prepareSharedUpgradeFiles({ root: f.root, plan: f.plan }), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  const g = fixture(), prepared = prepareSharedUpgradeFiles({ root: g.root, plan: g.plan });
  for (let i = 0; i < g.plan.sourceChanges.length; i++) prepared.replaceSource(i);
  writeFileSync(g.local(unchanged), 'outside-change');
  assert.throws(() => prepared.replaceConfig(), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  assert.equal(readFileSync(g.local(g.configPath), 'utf8'), g.text);
});

test('a plan cannot silently change existing service settings', () => {
  const f = fixture();
  const altered = { ...f.plan, nextConfig: { ...f.plan.nextConfig, maxAllocations: 20 } };
  assert.throws(() => prepareSharedUpgradeFiles({ root: f.root, plan: altered }), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
});

test('the file driver restores the old service after a failed upgrade', async () => {
  const f = fixture(); let running = true;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return true; }, async isActive() { return running; }, async stop() { running = false; }, async start() { running = true; },
    async verifyNew() { return false; }, async verifyOld() { return running; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  await assert.rejects(executeSharedHostedUpgrade(f.plan, driver), { code: 'SHARED_HOSTED_UPGRADE_FAILED' });
  assert.equal(running, true);
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
  assert.equal(readFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'), 'utf8'), 'original-registration');
});

test('a new process can recover an interrupted file update', async () => {
  const f = fixture(); let running = true;
  const service = { async guardReady() { return true; }, async stop() { running = false; }, async start() { running = true; }, async verifyOld() { return running; } };
  const previous = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan }); previous.replaceSource(0);
  assert.deepEqual(await recoverSharedHostedUpgrade({ root: f.root, service }), { recovered: true });
  assert.equal(running, true); assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
  assert.equal(readFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'), 'utf8'), 'original-registration');
});

test('a process exiting during replacement can be recovered by another process', () => {
  const f = fixture(); prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
  const moduleUrl = pathToFileURL(join(process.cwd(), 'relay/shared-hosted-upgrade-files.mjs')).href;
  const interrupted = `import {openSharedUpgradeFiles} from ${JSON.stringify(moduleUrl)}; openSharedUpgradeFiles({root:process.argv[1]}).replaceSource(0); process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', interrupted, f.root], { stdio: 'pipe' });
  const recovery = `import {openSharedUpgradeFiles} from ${JSON.stringify(moduleUrl)}; openSharedUpgradeFiles({root:process.argv[1]}).restore();`;
  execFileSync(process.execPath, ['--input-type=module', '-e', recovery, f.root], { stdio: 'pipe' });
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
  assert.equal(readFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'), 'utf8'), 'original-registration');
  for (const change of f.plan.sourceChanges) {
    if (change.beforeSha256 === null) assert.equal(existsSync(f.local(change.path)), false);
    else assert.match(readFileSync(f.local(change.path), 'utf8'), /^old:/);
  }
});

test('a linked source directory is rejected before any backup or replacement', { skip: process.platform === 'win32' }, () => {
  const f = fixture(), relay = f.local('/opt/rayneo-paseo-shared/relay'), saved = relay + '-fixture';
  renameSync(relay, saved); symlinkSync(saved, relay, 'dir');
  assert.throws(() => prepareSharedUpgradeFiles({ root: f.root, plan: f.plan }), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
  assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup')), false);
});

test('an upgrade is accepted only when files and service both verify', async () => {
  const f = fixture(); let running = true;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return true; }, async isActive() { return running; }, async stop() { running = false; }, async start() { running = true; },
    async verifyNew() { return running; }, async verifyOld() { return running; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  assert.deepEqual(await executeSharedHostedUpgrade(f.plan, driver), { upgraded: true });
  assert.equal(JSON.parse(readFileSync(f.local(f.configPath), 'utf8')).inviteDatabasePath, '/var/lib/rayneo-paseo-shared-hosted/invites.sqlite');
  assert.equal(readFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'), 'utf8'), 'original-registration');
});

test('a changed file cannot be accepted as a successful upgrade', async () => {
  const f = fixture(); let running = true;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return true; }, async isActive() { return running; }, async stop() { running = false; }, async start() { running = true; },
    async verifyNew() { writeFileSync(f.local(f.plan.sourceChanges[0].path), 'outside-change'); return true; }, async verifyOld() { return running; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  await assert.rejects(executeSharedHostedUpgrade(f.plan, driver), { code: 'SHARED_HOSTED_UPGRADE_UNCERTAIN' });
  assert.equal(readFileSync(f.local(f.plan.sourceChanges[0].path), 'utf8'), 'outside-change');
});

test('an injected test service cannot be used on the real server root', () => {
  if (process.platform !== 'linux') return;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return true; }, async isActive() { return true; }, async stop() {}, async start() {}, async verifyNew() { return true; }, async verifyOld() { return true; } };
  assert.throws(() => createSharedHostedUpgradeDriver({ root: '/', service }), { code: 'SHARED_HOSTED_UPGRADE_DRIVER_INVALID' });
});

test('an unhealthy current service is never stopped or modified', async () => {
  const f = fixture(); let stopped = false;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return true; }, async isActive() { return true; }, async stop() { stopped = true; }, async start() {},
    async verifyNew() { return true; }, async verifyOld() { return false; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  await assert.rejects(executeSharedHostedUpgrade(f.plan, driver), { code: 'SHARED_HOSTED_UPGRADE_PREFLIGHT_FAILED' });
  assert.equal(stopped, false); assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup')), false);
});

test('an upgrade cannot start before the startup guard is installed', async () => {
  const f = fixture(); let stopped = false;
  const service = { async guardReady() { return false; }, async canProbeEnrollment() { return true; }, async isActive() { return true; }, async stop() { stopped = true; }, async start() {},
    async verifyNew() { return true; }, async verifyOld() { return true; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  await assert.rejects(executeSharedHostedUpgrade(f.plan, driver), { code: 'SHARED_HOSTED_UPGRADE_PREFLIGHT_FAILED' });
  assert.equal(stopped, false); assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup')), false);
});

test('an upgrade cannot begin if a safe invitation probe is unavailable', async () => {
  const f = fixture(); let stopped = false;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return false; }, async isActive() { return true; },
    async stop() { stopped = true; }, async start() {}, async verifyNew() { return true; }, async verifyOld() { return true; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  await assert.rejects(executeSharedHostedUpgrade(f.plan, driver), { code: 'SHARED_HOSTED_UPGRADE_PREFLIGHT_FAILED' });
  assert.equal(stopped, false); assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup')), false);
});

test('service is not stopped when the startup guard disappears after backup', async () => {
  const f = fixture(); let stopped = false, checks = 0;
  const service = { async guardReady() { return ++checks === 1; }, async canProbeEnrollment() { return true; }, async isActive() { return true; },
    async stop() { stopped = true; }, async start() {}, async verifyNew() { return true; }, async verifyOld() { return true; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  await assert.rejects(executeSharedHostedUpgrade(f.plan, driver), { code: 'SHARED_HOSTED_UPGRADE_UNCERTAIN' });
  assert.equal(stopped, false); assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
});

test('startup guard allows complete states but blocks an interrupted replacement', () => {
  const f = fixture(); assert.equal(checkUpgradeStartup({ root: f.root }), true);
  const files = prepareSharedUpgradeFiles({ root: f.root, plan: f.plan });
  assert.equal(checkUpgradeStartup({ root: f.root }), true);
  files.replaceSource(0); assert.equal(checkUpgradeStartup({ root: f.root }), false);
  for (let i = 1; i < f.plan.sourceChanges.length; i++) files.replaceSource(i);
  assert.equal(checkUpgradeStartup({ root: f.root }), false);
  files.replaceConfig(); assert.equal(checkUpgradeStartup({ root: f.root }), true);
  writeFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup/before-config'), 'corrupted');
  assert.equal(checkUpgradeStartup({ root: f.root }), false);
});

test('startup guard blocks incomplete backups and related files changed outside the upgrade', () => {
  const f = fixture();
  mkdirSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup'));
  assert.equal(checkUpgradeStartup({ root: f.root }), false);
  const g = fixture(); prepareSharedUpgradeFiles({ root: g.root, plan: g.plan });
  writeFileSync(g.local('/opt/rayneo-paseo-shared/relay/shared-router.mjs'), 'outside-change');
  assert.equal(checkUpgradeStartup({ root: g.root }), false);
});

test('startup is blocked while an upgrade holds the exclusive start lock', () => {
  const f = fixture(); assert.equal(checkUpgradeStartup({ root: f.root }), true);
  const lock = acquireSharedUpgradeStartupLock({ root: f.root });
  try { assert.equal(checkUpgradeStartup({ root: f.root }), false); }
  finally { lock.release(); }
  assert.equal(checkUpgradeStartup({ root: f.root }), true);
});

test('the startup lock is held until all upgrade files are consistent', async () => {
  const f = fixture(); let running = true, blockedDuringStop = false, allowedAtStart = false;
  const service = { async guardReady() { return true; }, async canProbeEnrollment() { return true; }, async isActive() { return running; },
    async stop() { blockedDuringStop = !checkUpgradeStartup({ root: f.root }); running = false; },
    async start() { allowedAtStart = checkUpgradeStartup({ root: f.root }); running = true; },
    async verifyNew() { return running; }, async verifyOld() { return running; } };
  const driver = createSharedHostedUpgradeDriver({ root: f.root, service });
  assert.deepEqual(await executeSharedHostedUpgrade(f.plan, driver), { upgraded: true });
  assert.equal(blockedDuringStop, true); assert.equal(allowedAtStart, true);
});

test('interruption while preparing a backup leaves the original service startable', () => {
  const f = fixture(), preparing = f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup.prepare');
  mkdirSync(preparing); writeFileSync(join(preparing, 'partial'), 'synthetic');
  assert.equal(checkUpgradeStartup({ root: f.root }), true);
  assert.throws(() => prepareSharedUpgradeFiles({ root: f.root, plan: f.plan }), { code: 'SHARED_UPGRADE_FILES_CONFLICT' });
  assert.equal(readFileSync(f.local(f.configPath), 'utf8'), f.text);
  assert.equal(existsSync(f.local('/var/lib/rayneo-paseo-shared-hosted/upgrade-backup')), false);
});

test('the upgrade loader compares the actual existing files with a staged bundle', () => {
  const f = fixture(), candidateRoot = join(f.root, 'candidate'); mkdirSync(candidateRoot);
  for (const [path, bytes] of Object.entries(f.candidateSources)) {
    const relative = path.replace('/opt/rayneo-paseo-shared/', ''), target = join(candidateRoot, relative);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  const plan = loadSharedHostedUpgradePlan({ root: f.root, candidateRoot });
  assert.equal(plan.sourceChanges.length, f.plan.sourceChanges.length);
  assert.equal(plan.configBeforeSha256, f.plan.configBeforeSha256);
  assert.equal(readFileSync(f.local('/var/lib/rayneo-paseo-shared-hosted/registry.sqlite'), 'utf8'), 'original-registration');
});

test('the upgrade loader refuses a bundle outside its isolated root', () => {
  const f = fixture();
  assert.throws(() => loadSharedHostedUpgradePlan({ root: f.root, candidateRoot: dirname(f.root) }), { code: 'SHARED_HOSTED_UPGRADE_LOAD_FAILED' });
});
