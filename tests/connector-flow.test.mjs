import test from 'node:test';
import assert from 'node:assert/strict';

test('a newly detected Codex is added once without creating repeated connection attempts', async () => {
  const { createAutoCodexConnector } = await import('../distribution/ui/view.js');
  let calls = 0; const auto = createAutoCodexConnector(async () => { calls++; });
  const status = { phase: 'configured', connectionMode: 'secure', available: ['paseo', 'codex'],
    connections: [{ backend: 'paseo', ready: true }], encryption: 'verified' };
  await auto(status); await auto(status);
  assert.equal(calls, 1);
  await auto({ ...status, connections: [...status.connections, { backend: 'codex', ready: true }] });
  assert.equal(calls, 1);
});
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const view = async status => (await import('../distribution/ui/view.js')).connectionView(status);
const connected = { phase: 'existing', available: [], pairingEnabled: true, pairingReady: true,
  connections: [{ backend: 'paseo', ready: true, local: 'ready', wireless: 'ready' }] };

test('first-use guidance distinguishes detection from verified login and explains the next step', async () => {
  const { assistantGuidance } = await import('../distribution/ui/view.js');
  assert.match(assistantGuidance([]), /打开并登录/);
  assert.match(assistantGuidance(['codex']), /Codex/);
  assert.match(assistantGuidance(['codex']), /登录/);
  assert.doesNotMatch(assistantGuidance(['codex']), /已登录/);
  assert.match(assistantGuidance(['paseo', 'codex']), /Paseo.*Codex/);
});

test('assistant status distinguishes discovery, live connection and a failed connection', async () => {
  const { assistantStatus } = await import('../distribution/ui/view.js');
  assert.equal(assistantStatus({ phase: 'new', available: ['codex'], connections: [] }, 'codex').label, '已检测');
  assert.equal(assistantStatus({ phase: 'new', available: ['codex'], connections: [] }, 'paseo').label, '未检测到');
  assert.equal(assistantStatus({ phase: 'configured', available: [], connections: [{ backend: 'codex', ready: true }] }, 'codex').label, '已连接');
  assert.equal(assistantStatus({ phase: 'configured', available: ['codex'], connections: [{ backend: 'codex', ready: false, local: 'reconnecting' }] }, 'codex').label, '连接中');
  assert.equal(assistantStatus({ phase: 'configured', available: ['codex'], connections: [{ backend: 'codex', ready: false, local: 'unreachable' }] }, 'codex').label, '连接中断');
});

test('configured connection warns when an installed assistant was never included', async () => {
  const { assistantStatus, connectionView } = await import('../distribution/ui/view.js');
  const status = { phase: 'configured', available: ['codex', 'paseo'], connections: [{ backend: 'paseo', ready: true }], pairingEnabled: true, pairingReady: true };
  const codex = assistantStatus(status, 'codex');
  assert.equal(codex.label, '已检测');
  assert.match(codex.detail, /尚未加入/);
  assert.match(codex.detail, /扫码/);
  assert.equal(connectionView(status).kind, 'partial');
  assert.equal(connectionView({ ...status, connectionMode: 'secure' }).canAddCodex, true);
  assert.equal(connectionView({ ...status, available: ['paseo'], connectionMode: 'secure' }).canAddCodex, false);
  assert.equal(connectionView({ ...status, connectionMode: 'legacy' }).canAddCodex, false);
});

test('first connection uses automatic detection and exposes configuration only when needed', async () => {
  const first = await view({ phase: 'new', available: ['paseo', 'codex'], connections: [] });
  assert.equal(first.kind, 'first'); assert.equal(first.canConnect, true); assert.equal(first.showSetup, false);
  const missing = await view({ phase: 'new', available: [], connections: [] });
  assert.equal(missing.canConnect, false);
  const prepared = await view({ phase: 'prepared', available: ['paseo'], connections: [], enrollmentAvailable: true });
  assert.equal(prepared.kind, 'setup'); assert.equal(prepared.showSetup, true); assert.equal(prepared.canPair, false);
});

test('prepared hosted connections can start automatically while self-hosted setup waits for its configuration', async () => {
  const { connectionView } = await import('../distribution/ui/view.js');
  const status = { phase: 'prepared', available: ['paseo'], connections: [], enrollmentAvailable: true, hostedEnrollmentAvailable: true };
  assert.equal(connectionView(status, 'project-hosted').canStart, true);
  assert.equal(connectionView(status, 'self-hosted').canStart, false);
  assert.equal(connectionView({ ...status, hostedEnrollmentAvailable: false }, 'project-hosted').canStart, false);
});

test('configured healthy service stays on status screen even when local assistant detection is unavailable', async () => {
  const current = await view(connected);
  assert.equal(current.kind, 'ready'); assert.equal(current.showSetup, false); assert.equal(current.canPair, true);
  assert.equal(current.canConnect, true);
});

test('temporary loss and reconnecting never send an existing installation back through onboarding', async () => {
  for (const local of ['network_unavailable', 'reconnecting', 'unreachable']) {
    const current = await view({ ...connected, pairingReady: false,
      connections: [{ backend: 'paseo', ready: false, local, wireless: 'network_unavailable' }] });
    assert.equal(current.kind, 'disconnected'); assert.equal(current.showSetup, false);
    assert.equal(current.canConnect, true); assert.equal(current.canPair, false);
  }
});

test('secure status is honest about verification and keeps existing settings during loss or configuration errors', async () => {
  const unverified = await view({ ...connected, connectionMode: 'secure', encryption: 'unverified', pairingReady: false,
    connections: [{ backend: 'paseo', ready: false, local: 'ready', wireless: 'network_unavailable' }] });
  assert.equal(unverified.kind, 'disconnected'); assert.equal(unverified.canPair, false); assert.equal(unverified.showSetup, false);
  const verified = await view({ ...connected, connectionMode: 'secure', encryption: 'verified' });
  assert.equal(verified.canPair, true);
  const falseReady = await view({ ...connected, connectionMode: 'secure', encryption: 'unverified' });
  assert.equal(falseReady.canPair, false);
  const damaged = await view({ ...connected, connectionMode: 'secure', encryption: 'unverified', secureError: 'SECURE_CONFIGURATION_INVALID',
    pairingReady: false, connections: [] });
  assert.equal(damaged.kind, 'repair'); assert.equal(damaged.showSetup, false);
});

test('rejected access shows targeted repair while another healthy assistant remains usable', async () => {
  const current = await view({ ...connected, connections: [...connected.connections,
    { backend: 'codex', ready: false, local: 'ready', wireless: 'rejected' }] });
  assert.equal(current.kind, 'partial'); assert.equal(current.needsRepair, true);
  assert.equal(current.showSetup, false); assert.equal(current.canPair, true);
  const rejected = await view({ ...connected, pairingReady: false, connections: [
    { backend: 'paseo', ready: false, local: 'ready', wireless: 'rejected' }] });
  assert.equal(rejected.kind, 'repair'); assert.equal(rejected.showSetup, false);
});

test('claiming QR never labels the phone as paired or continuously online', async () => {
  for (const pairingState of ['none', 'claimed', 'expired']) {
    const current = await view({ ...connected, pairingState });
    assert.equal(current.kind, 'ready'); assert.equal(current.phoneVerified, false);
  }
});

test('pairing excludes a failed assistant and cannot offer a QR whose host is excluded', async t => {
  const { selectPairingProfiles } = await import('../distribution/actions.mjs');
  const profiles = { paseo: { endpoint: 'https://example.test/paseo', port: 7468, token: 'a'.repeat(64) },
    codex: { endpoint: 'https://example.test/codex', port: 19469, token: 'b'.repeat(64) } };
  const status = { connections: [{ backend: 'paseo', ready: true, wireless: 'ready' },
    { backend: 'codex', ready: false, wireless: 'reconnecting' }] };
  assert.deepEqual(Object.keys(selectPairingProfiles(status, profiles, 'paseo')), ['paseo']);
  assert.throws(() => selectPairingProfiles(status, profiles, 'codex'), { code: 'CONNECTOR_NOT_READY' });
  assert.throws(() => selectPairingProfiles({ connections: [status.connections[0]] }, profiles, 'codex'),
    { code: 'CONNECTOR_NOT_READY' });
  const { createPairingStore } = await import('../bridge/pairing.mjs');
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-flow'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'pair-')); t.after(() => rmSync(directory, { recursive: true }));
  const store = createPairingStore({ directory });
  const ticket = store.issue({ computerLabel: '测试电脑', profiles: selectPairingProfiles(status, profiles, 'paseo'), publicBaseUrl: profiles.paseo.endpoint });
  assert.deepEqual(Object.keys(store.claim(ticket.url.split('rayneo_pair=')[1]).profiles), ['paseo']);
});

test('a blocked Codex desktop cannot prevent independent Paseo recovery or close the desktop', async () => {
  const { startAvailableConnections } = await import('../distribution/actions.mjs');
  const launched = [];
  const result = startAvailableConnections({ backends: ['codex', 'paseo'], connections: [], isLaunching: () => false,
    desktop: () => ({ desktopRunning: true, sharedReady: false }), launch: backend => launched.push(backend) });
  assert.deepEqual(launched, ['paseo']);
  assert.deepEqual(result.blocked, [{ backend: 'codex', reason: 'CODEX_CLOSE_REQUIRED' }]);
  assert.equal(result.existingDesktopStopped, false);
});

test('an assistant already recovering is not started twice and desktop inspection failure stays local', async () => {
  const { startAvailableConnections } = await import('../distribution/actions.mjs');
  const launched = [];
  const result = startAvailableConnections({ backends: ['codex', 'paseo'], connections: [{ backend: 'paseo', local: 'reconnecting' }],
    isLaunching: () => false, desktop: () => { throw Error('desktop check failed'); }, launch: backend => launched.push(backend) });
  assert.deepEqual(launched, []); assert.deepEqual(result.blocked, [{ backend: 'codex', reason: 'CONNECTOR_PLATFORM_STEP_FAILED' }]);
});
