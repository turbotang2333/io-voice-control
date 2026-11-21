import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../distribution/secure-actions.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});

function fixture(secureStatus = { phase: 'unconfigured', encryption: 'unverified', connections: [], pairingReady: false }) {
  const calls = [];
  const legacy = { async status() { return { phase: 'prepared', available: ['paseo'], enrollmentAvailable: true, connections: [] }; },
    enrollment() { return { version: 1 }; }, prepare() { calls.push('prepare'); }, invitation() { calls.push('legacy-invitation'); },
    connect() { calls.push('legacy-connect'); }, pair() { calls.push('legacy-pair'); } };
  const secure = { async status() { return secureStatus; }, configure(value) { calls.push(['secure-configure', value.version]); return { configured: true }; },
    connect() { calls.push('secure-connect'); return { starting: true, blocked: [], modelMessagesSent: 0 }; },
    pair() { calls.push('secure-pair'); return { image: 'safe' }; } };
  return { calls, actions: api.createSecureDashboardActions({ legacy, secure }) };
}

test('an already configured hosted connection reconnects without asking for a new invitation', async () => {
  let connections = 0, enrollments = 0;
  const actions = api.createSecureDashboardActions({
    legacy: { connect() { throw Error('unexpected legacy connection'); } },
    secure: { async status() { return { phase: 'configured', hosting: 'project-hosted' }; },
      async connect() { connections++; return { started: true }; } },
    hostedRequest() { enrollments++; throw Error('unexpected registration'); },
  });
  assert.deepEqual(await actions.connect({ hosting: 'project-hosted' }), { started: true });
  assert.equal(connections, 1); assert.equal(enrollments, 0);
});

test('a temporary Codex detection failure at first setup can leave a Paseo-only connection despite later detection', async () => {
  const { assistantStatus, connectionView } = await import('../distribution/ui/view.js');
  let available = ['paseo'], requestedBackends = [], phase = 'new', configured = false;
  const legacy = {
    async status() { return { phase, available, requestedBackends, connections: [] }; },
    async connect() { requestedBackends = [...available]; phase = 'prepared'; return { needsConfiguration: true }; },
    enrollment() { return { version: 1, installationId: '77f750d4-fbda-4772-8bf7-6014cbc98776', requestedBackends,
      sshPublicKey: 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64') }; },
  };
  const secure = { async status() { return configured ? { phase: 'configured', encryption: 'verified', pairingReady: true,
    connections: [{ backend: 'paseo', local: 'ready', wireless: 'ready', ready: true }] } : { phase: 'unconfigured' }; },
    async configure() { configured = true; }, async connect() { return { starting: true }; } };
  const actions = api.createSecureDashboardActions({ legacy, secure, hostedRequest: async request => ({
    version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: request.installationId,
    publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: request.requestedBackends,
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: request.sshPublicKey },
  }) });
  await actions.connect({ hosting: 'project-hosted' });
  available = ['paseo', 'codex'];
  const status = await actions.status(true);
  assert.deepEqual(status.requestedBackends, ['paseo']);
  assert.equal(assistantStatus(status, 'codex').label, '已检测');
  assert.equal(connectionView(status).canAddCodex, true);
});

test('new encrypted invitations are configured through the secure entry while old invitations retain compatibility', async () => {
  assert.equal(typeof api.createSecureDashboardActions, 'function');
  const f = fixture();
  await f.actions.invitation({ version: 2, transport: 'tls-passthrough-v1' });
  await f.actions.invitation({ version: 3, transport: 'tls-passthrough-v1' });
  await f.actions.invitation({ version: 1 });
  assert.deepEqual(f.calls, [['secure-configure', 2], ['secure-configure', 3], 'legacy-invitation']);
  assert.equal((await f.actions.status()).phase, 'prepared');
});

test('configured secure connection takes precedence and only reports encryption after verification', async () => {
  assert.equal(typeof api.createSecureDashboardActions, 'function');
  const f = fixture({ phase: 'configured', hosting: 'self-hosted', encryption: 'unverified', transport: 'tls-passthrough-v1',
    pairingReady: false, pairingState: 'none', connections: [{ backend: 'paseo', local: 'ready', wireless: 'network_unavailable', ready: false }] });
  const status = await f.actions.status();
  assert.equal(status.phase, 'configured'); assert.equal(status.connectionMode, 'secure');
  assert.equal(status.encryption, 'unverified'); assert.equal(status.pairingReady, false);
  assert.equal(status.enrollmentAvailable, true);
  await f.actions.connect(); await f.actions.pair();
  assert.deepEqual(f.calls, ['secure-connect', 'secure-pair']);
  await assert.rejects(f.actions.invitation({ version: 1 }), { code: 'SECURE_CONFIGURATION_EXISTS' });
});

test('broken secure configuration keeps the status page and never falls back to the legacy connection', async () => {
  assert.equal(typeof api.createSecureDashboardActions, 'function');
  const f = fixture({ phase: 'configuration_error', encryption: 'unverified', code: 'SECURE_CONFIGURATION_INVALID', connections: [], pairingReady: false });
  const status = await f.actions.status();
  assert.equal(status.phase, 'configured'); assert.equal(status.connectionMode, 'secure');
  assert.equal(status.secureError, 'SECURE_CONFIGURATION_INVALID');
  await f.actions.connect(); await f.actions.pair();
  assert.deepEqual(f.calls, ['secure-connect', 'secure-pair']);
});

test('a trusted hosted provider can prepare, request, configure and connect in one action', async () => {
  const { randomUUID } = await import('node:crypto');
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key, apiToken: 'private' };
  const invitation = { version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: enrollment.installationId,
    publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: ['paseo'],
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } };
  const calls = [], legacy = { async status() { return { phase: 'new', available: ['paseo'], connections: [] }; },
    async connect() { calls.push('prepare'); return { needsConfiguration: true }; }, enrollment() { return enrollment; } };
  const secure = { async status() { return { phase: 'unconfigured' }; }, async configure(value) { calls.push(['configure', value.installationId]); },
    async connect() { calls.push('connect'); return { starting: true }; } };
  const hostedRequest = async value => { calls.push(['request', value]); return invitation; };
  const actions = api.createSecureDashboardActions({ legacy, secure, hostedRequest });
  assert.equal((await actions.status()).hostedEnrollmentAvailable, true);
  const result = await actions.connect({ hosting: 'project-hosted' });
  assert.equal(result.starting, true);
  assert.deepEqual(calls, ['prepare', ['request', { version: 1, installationId: enrollment.installationId, requestedBackends: ['paseo'], sshPublicKey: key }],
    ['configure', enrollment.installationId], 'connect']);
});

test('automatic hosted enrollment is not attempted for self-hosting, legacy connections, or an invalid response', async () => {
  const { randomUUID } = await import('node:crypto');
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key };
  let requested = 0, configured = 0, needsConfiguration = true;
  const legacy = { async status() { return { phase: 'prepared', available: ['paseo'], connections: [] }; },
    async connect() { return { needsConfiguration }; }, enrollment() { return enrollment; } };
  const secure = { async status() { return { phase: 'unconfigured' }; }, async configure() { configured++; }, async connect() { throw Error('must not connect'); } };
  const actions = api.createSecureDashboardActions({ legacy, secure, hostedRequest: async () => { requested++; return { version: 1 }; } });
  await actions.connect({ hosting: 'self-hosted' }); assert.equal(requested, 0);
  needsConfiguration = false; await actions.connect({ hosting: 'project-hosted' }); assert.equal(requested, 0);
  needsConfiguration = true;
  await assert.rejects(actions.connect({ hosting: 'project-hosted' }), { code: 'HOSTED_RESPONSE_INVALID' });
  assert.equal(requested, 1); assert.equal(configured, 0);
});

test('simultaneous hosted connection requests share one allocation and do not overwrite a concurrent configuration', async () => {
  const { randomUUID } = await import('node:crypto');
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key };
  const invitation = { version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: enrollment.installationId,
    publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: ['paseo'],
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } };
  let configured = 0, requested = 0, phase = 'unconfigured', release;
  const waiting = new Promise(resolve => { release = resolve; });
  const legacy = { async connect() { return { needsConfiguration: true }; }, enrollment() { return enrollment; } };
  const secure = { async status() { return { phase }; }, async configure() { configured++; }, async connect() { return {}; } };
  const actions = api.createSecureDashboardActions({ legacy, secure, hostedRequest: async () => { requested++; await waiting; return invitation; } });
  const first = actions.connect({ hosting: 'project-hosted' }), second = actions.connect({ hosting: 'project-hosted' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requested, 1);
  phase = 'configured'; release();
  await assert.rejects(first, { code: 'SECURE_CONFIGURATION_EXISTS' });
  await assert.rejects(second, { code: 'SECURE_CONFIGURATION_EXISTS' });
  assert.equal(configured, 0);
});

test('existing installations can enter hosted encryption without launching or replacing their old connection', async () => {
  const { randomUUID } = await import('node:crypto');
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
  const enrollment = { version: 1, installationId: randomUUID(), requestedBackends: ['paseo'], sshPublicKey: key };
  const invitation = { version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: enrollment.installationId,
    publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: ['paseo'],
    relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: key } };
  const calls = [];
  const legacy = { async status() { return { phase: 'existing', connections: [] }; },
    async connect() { assert.fail('must not start or replace the old connection'); } };
  const secure = { async status() { return { phase: 'unconfigured' }; }, async configure(value) { calls.push(['configure', value.version]); },
    async connect() { calls.push('secure-connect'); return { starting: true }; } };
  const actions = api.createSecureDashboardActions({ legacy, secure, prepareExisting: async () => { calls.push('prepare-existing'); return enrollment; },
    hostedRequest: async () => { calls.push('request'); return invitation; } });
  assert.equal((await actions.connect({ hosting: 'project-hosted' })).starting, true);
  assert.deepEqual(calls, ['prepare-existing', 'request', ['configure', 3], 'secure-connect']);
});
