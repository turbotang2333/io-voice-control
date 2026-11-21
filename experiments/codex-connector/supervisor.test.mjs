import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { superviseCommand } from '../../bridge/supervisor.mjs';
import { tlsFixture } from '../../tests/helpers/tls-fixture.mjs';
const api = await import('./supervisor.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const profile = { host: '127.0.0.1', port: 19469, token: 'a'.repeat(64), navigation: true,
  pfxPath: 'C:\\private\\server.p12', password: 'synthetic' };
const configPath = resolve('synthetic-connector.json');
const wireless = { endpoint: 'https://example.invalid/codex', localPort: 19469, remoteLoopbackPort: 17469,
  configPath, sshHost: 'synthetic-host' };

test('maintenance validates the exact connector and existing HTTPS route before starting anything', () => {
  assert.equal(typeof api.connectorMaintenancePlan, 'function');
  const plan = api.connectorMaintenancePlan(profile, wireless, configPath);
  assert.ok(plan.serviceArgs.includes(configPath));
  assert.ok(plan.relayArgs.includes('127.0.0.1:17469:127.0.0.1:19469'));
  assert.ok(!JSON.stringify(plan).includes(profile.token));
  for (const change of [{ localPort: 7468 }, { remoteLoopbackPort: 17477 }, { sshHost: '-unsafe' },
    { configPath: resolve('other.json') }, { endpoint: 'http://example.invalid/codex' },
    { endpoint: 'https://user:pass@example.invalid/codex' }, { endpoint: 'https://example.invalid/codex?token=secret' }]) {
    assert.throws(() => api.connectorMaintenancePlan(profile, { ...wireless, ...change }, configPath));
  }
});

test('local-only maintenance needs no wireless invitation and contains no relay command or credentials', () => {
  assert.equal(typeof api.localConnectorMaintenancePlan, 'function');
  const plan = api.localConnectorMaintenancePlan(profile, configPath);
  assert.equal(plan.localOnly, true);
  assert.equal(plan.relayArgs, undefined);
  assert.equal(plan.publicHealth, undefined);
  assert.ok(plan.serviceArgs.includes(configPath));
  assert.ok(!JSON.stringify(plan).includes(profile.token));
  assert.throws(() => api.localConnectorMaintenancePlan(profile, 'relative.json'));
});

test('local-only maintenance recovers its own connector without starting or probing a relay', async t => {
  assert.equal(typeof api.localConnectorMaintenancePlan, 'function');
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'local-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worker = join(root, 'worker.mjs'), count = join(root, 'count');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const p=process.argv[2],n=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;
    writeFileSync(p,String(n));if(n===1)process.exit(1);setInterval(()=>{},1000);`);
  let starts = 0, remoteProbes = 0;
  const maintenance = api.startConnectorMaintenance({ plan: api.localConnectorMaintenancePlan(profile, configPath), stateDirectory: root,
    probeLocal: async () => 'ready', probePublic: async () => { remoteProbes++; return 'ready'; }, intervalMs: 10,
    startJob(options) {
      starts++; assert.equal(options.command, process.execPath);
      return superviseCommand({ ...options, args: [worker, count], minDelayMs: 5, maxDelayMs: 10 });
    } });
  t.after(() => maintenance.stop());
  const deadline = Date.now() + 6000;
  while ((!existsSync(count) || readFileSync(count, 'utf8') !== '2') && Date.now() < deadline) await new Promise(r => setTimeout(r, 15));
  assert.equal(readFileSync(count, 'utf8'), '2');
  await maintenance.stop();
  assert.equal(starts, 1); assert.equal(remoteProbes, 0);
});

test('local-only CLI checks a fresh local configuration without a wireless file or a user credential', () => {
  const identity = tlsFixture('local-codex-check'), file = join(identity.directory, 'connector.json');
  writeFileSync(join(identity.directory, 'local.cer'), identity.cert);
  writeFileSync(file, JSON.stringify({ ...profile, pfxPath: join(identity.directory, 'server.p12'), password: identity.passphrase }));
  const invoke = args => execFileSync(process.execPath, [resolve('experiments/codex-connector/supervisor.mjs'), 'check', '--config', file, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const result = JSON.parse(invoke(['--local-only']));
  assert.equal(result.prepared, true); assert.equal(result.relayStarted, false); assert.equal(result.localOnly, true);
  assert.equal(result.modelMessagesSent, 0);
  assert.throws(() => invoke(['--local-only', '--wireless', join(identity.directory, 'missing.json')]));
});

test('maintenance recovers its crashed service and relay, then stops only its own processes', async t => {
  assert.equal(typeof api.startConnectorMaintenance, 'function');
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'maintenance-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(parent) + sep)); rmSync(root, { recursive: true, force: true }); });
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const [path,crash]=process.argv.slice(2),n=existsSync(path)?Number(readFileSync(path,'utf8'))+1:1;
    writeFileSync(path,String(n));if(crash==='first'&&n===1)process.exit(1);setInterval(()=>{},1000);`);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await once(unrelated, 'spawn'); t.after(() => unrelated.kill());
  const events = []; let starts = 0, relay;
  const maintenance = api.startConnectorMaintenance({
    plan: api.connectorMaintenancePlan(profile, wireless, configPath), stateDirectory: root,
    probeLocal: async () => 'ready', probePublic: async () => relay?.getState().running ? 'ready' : 'unreachable',
    intervalMs: 15, cooldownMs: 0, failureThreshold: 1,
    startJob(options) {
      const service = starts++ === 0;
      const job = superviseCommand({ ...options, command: process.execPath,
        args: [worker, join(root, service ? 'service-count' : 'relay-count'), service ? 'first' : 'never'],
        minDelayMs: 5, maxDelayMs: 10, onEvent(value) { events.push({ service, ...value }); options.onEvent(value); } });
      if (!service) relay = job;
      return job;
    },
  });
  t.after(() => maintenance.stop());
  const waitFor = async fn => {
    const until = Date.now() + 6000;
    while (!fn() && Date.now() < until) await new Promise(r => setTimeout(r, 15));
    assert.ok(fn());
  };
  const count = name => existsSync(join(root, name)) ? Number(readFileSync(join(root, name), 'utf8')) : 0;
  await waitFor(() => count('service-count') === 2 && count('relay-count') === 1);
  const relayPid = events.find(e => !e.service && e.type === 'started').pid;
  process.kill(relayPid);
  await waitFor(() => count('relay-count') === 2);
  await maintenance.stop();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(count('service-count'), 2); assert.equal(count('relay-count'), 2);
  assert.equal(unrelated.exitCode, null);
});
