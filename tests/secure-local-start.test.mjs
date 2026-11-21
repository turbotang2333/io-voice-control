import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const api = await import('../secure-link/local-backends.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
const privateDirectory = join(homedir(), '.local-secrets/rayneo-paseo');
const configuration = { backends: {
  paseo: { port: 7468, upstreamToken: 'a'.repeat(64), ca: 'disposable' },
  codex: { port: 19469, upstreamToken: 'b'.repeat(64), ca: 'disposable' },
} };

test('secure startup launches local-only connectors and deduplicates repeated clicks without a model request', async t => {
  assert.equal(typeof api.createLocalConnectionStarter, 'function');
  const children = [], commands = [];
  t.after(async () => { await Promise.all(children.map(child => new Promise(accept => { child.ref(); child.once('close', accept); child.kill(); }))); });
  const starter = api.createLocalConnectionStarter({ codeRoot: resolve('.'), privateDirectory,
    probeLocal: async () => 'network_unavailable', desktop: () => ({ installed: true, desktopRunning: false, sharedReady: false }),
    spawnChild(command, args, options) {
      commands.push({ command, args, options });
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
      children.push(child); return child;
    } });
  const [first, second] = await Promise.all([starter.start(configuration), starter.start(configuration)]);
  assert.deepEqual(first.started, ['paseo', 'codex']); assert.deepEqual(second, first);
  assert.equal(commands.length, 2);
  assert.ok(commands[0].args.includes('--local-only'));
  assert.ok(commands[1].args.includes('-LocalOnly'));
  assert.ok(commands[1].args.includes(join(privateDirectory, 'shared-runtime/startup.json')));
  for (const command of commands) {
    assert.equal(command.options.windowsHide, true); assert.equal(command.options.stdio, 'ignore');
    assert.ok(!JSON.stringify(command).includes('a'.repeat(64)));
  }
  assert.deepEqual((await starter.start(configuration)).started, []);
  assert.equal(commands.length, 2); assert.equal(first.modelMessagesSent, 0); assert.equal(first.existingDesktopStopped, false);
});

test('a normal Codex window stays open while independent Paseo startup continues', async t => {
  assert.equal(typeof api.createLocalConnectionStarter, 'function');
  let child;
  t.after(() => child && new Promise(accept => { child.ref(); child.once('close', accept); child.kill(); }));
  const starter = api.createLocalConnectionStarter({ codeRoot: resolve('.'), privateDirectory,
    probeLocal: async () => 'network_unavailable', desktop: () => ({ installed: true, desktopRunning: true, sharedReady: false }),
    spawnChild(command, args) {
      assert.ok(args.includes('--local-only'));
      return child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    } });
  const result = await starter.start(configuration);
  assert.deepEqual(result.started, ['paseo']);
  assert.deepEqual(result.blocked, [{ backend: 'codex', reason: 'CODEX_CLOSE_REQUIRED' }]);
  assert.equal(result.existingDesktopStopped, false);
});

test('independent Codex starts without closing or relaunching the desktop', async t => {
  let child, captured;
  t.after(() => child && new Promise(accept => { child.ref(); child.once('close', accept); child.kill(); }));
  const starter = api.createLocalConnectionStarter({ codeRoot: resolve('.'), privateDirectory,
    probeLocal: async () => 'network_unavailable', desktop: () => ({ installed: true, desktopRunning: true, sharedReady: false }),
    spawnChild(command, args) { captured={command,args}; return child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); } });
  const result = await starter.start({ backends: { codex: { ...configuration.backends.codex, mode: 'independent' } } });
  assert.deepEqual(result.started, ['codex']); assert.deepEqual(result.blocked, []);
  assert.equal(captured.command, process.execPath);
  assert.ok(captured.args.includes('--local-only'));
  assert.ok(captured.args.includes(join(privateDirectory, 'shared-runtime/connector.json')));
  assert.equal(result.existingDesktopStopped, false);
});

test('healthy, reconnecting and identity-rejected local connections are never relaunched', async () => {
  assert.equal(typeof api.createLocalConnectionStarter, 'function');
  for (const state of ['ready', 'reconnecting', 'rejected']) {
    const starter = api.createLocalConnectionStarter({ codeRoot: resolve('.'), privateDirectory,
      probeLocal: async () => state, desktop: () => assert.fail('no desktop inspection needed'),
      spawnChild: () => assert.fail('must not compete with an existing connection') });
    const result = await starter.start(configuration);
    assert.deepEqual(result.started, []);
    assert.equal(result.blocked.length, state === 'rejected' ? 2 : 0);
  }
});

test('Windows local-only launch check accepts a fresh setup without legacy wireless configuration', { skip: process.platform !== 'win32' }, () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/secure-local-start'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), scripts = join(root, 'scripts'), runtime = join(root, 'experiments/codex-connector');
  mkdirSync(scripts); mkdirSync(runtime, { recursive: true });
  copyFileSync(resolve('scripts/run-codex-daily.ps1'), join(scripts, 'run-codex-daily.ps1'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  writeFileSync(join(scripts, 'resolve-node.ps1'), '\uFEFF' + quote(process.execPath));
  writeFileSync(join(scripts, 'start-codex-shared.ps1'), 'param([switch]$Check,[string]$Adapter,[string]$Configuration)\n$global:LASTEXITCODE=0\n');
  writeFileSync(join(runtime, 'supervisor.mjs'), `if(process.argv[2]!=='check'||!process.argv.includes('--local-only')||process.argv.includes('--wireless'))process.exit(1);`);
  const adapter = join(root, 'adapter.exe'), desktopConfiguration = join(root, 'desktop.json'), connectorConfiguration = join(root, 'connector.json');
  writeFileSync(adapter, 'not-executed');
  const connection = { endpoint: 'ws://127.0.0.1:19569/rpc', tokenFile: join(root, 'unused-token') };
  writeFileSync(desktopConfiguration, JSON.stringify({ executable: join(root, 'app/resources/codex.exe'), connection }));
  writeFileSync(connectorConfiguration, JSON.stringify({ sharedConnection: connection }));
  const startup = join(root, 'startup.json');
  writeFileSync(startup, JSON.stringify({ version: 1, adapter, desktopConfiguration, connectorConfiguration }));
  const wrapper = join(root, 'check.ps1');
  writeFileSync(wrapper, `\uFEFF$ErrorActionPreference='Stop'\n$env:USERPROFILE=${quote(root)}\nfunction Get-AppxPackage { [pscustomobject]@{InstallLocation=${quote(root)};Version='1.0'} }\n& ${quote(join(scripts, 'run-codex-daily.ps1'))} -Check -LocalOnly -Configuration ${quote(startup)}\n`);
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', wrapper], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }));
  assert.equal(result.prepared, true); assert.equal(result.localOnly, true); assert.equal(result.desktopStarted, false);
  assert.equal(result.modelMessagesSent, 0);
});
