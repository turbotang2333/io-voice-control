import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const api = await import('../distribution/hosted-enrollment.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString('base64');
const otherKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 2)]).toString('base64');
function request() { return { version: 1, installationId: randomUUID(), requestedBackends: ['paseo', 'codex'], sshPublicKey: key + ' comment', certificatePem: 'unused-public-certificate', apiToken: 'must-not-leave-computer' }; }
function invitation(enrollment) { return { version: 3, transport: 'tls-passthrough-v1', hosting: 'project-hosted', installationId: enrollment.installationId,
  publicBaseUrl: 'https://relay.example.test:24443', remoteSocket: '/tunnel/relay.sock', backends: ['codex', 'paseo'],
  relay: { host: 'relay.example.test', port: 2222, user: 'rayneo_test', hostKey: otherKey } }; }

test('hosted requests include only the minimum public enrollment information', () => {
  const value = request();
  assert.deepEqual(api.createHostedEnrollment(value), { version: 1, installationId: value.installationId, requestedBackends: ['paseo', 'codex'], sshPublicKey: key });
});

test('hosted enrollment rejects invalid identity, assistant lists and public keys', () => {
  for (const bad of [{ installationId: 'invalid' }, { requestedBackends: [] }, { requestedBackends: ['paseo', 'paseo'] },
    { requestedBackends: ['other'] }, { sshPublicKey: 'private key' }, { version: 2 }]) {
    assert.throws(() => api.createHostedEnrollment({ ...request(), ...bad }), { code: 'HOSTED_ENROLLMENT_INVALID' });
  }
});

test('hosted responses must match this computer, both assistants and the secure hosted format', () => {
  const enrollment = api.createHostedEnrollment(request()), response = invitation(enrollment);
  assert.equal(api.validateHostedResponse(response, enrollment).installationId, enrollment.installationId);
  for (const bad of [{ installationId: randomUUID() }, { hosting: 'self-hosted' }, { backends: ['paseo'] },
    { version: 2, remotePort: 28001, remoteSocket: undefined }, { publicBaseUrl: 'http://relay.example.test' }]) {
    assert.throws(() => api.validateHostedResponse({ ...response, ...bad }, enrollment), { code: 'HOSTED_RESPONSE_INVALID' });
  }
});

test('hosted enrollment uses HTTPS without redirects and sends only the minimum public fields', async () => {
  const input = request(); let call;
  const result = await api.requestHostedEnrollment({ enrollment: input, serviceUrl: 'https://enrollment.example.test/v1/enroll',
    fetchImpl: async (url, options) => { call = { url, options }; return new Response(JSON.stringify(invitation(input)), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(result.installationId, input.installationId);
  assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit');
  assert.deepEqual(JSON.parse(call.options.body), api.createHostedEnrollment(input));
  assert.ok(!call.options.body.includes('must-not-leave-computer'));
});

test('an invitation code is sent only in a request header and rejection is actionable', async () => {
  const input = request(), code = 'rnp-' + 'A'.repeat(43); let sent;
  await api.requestHostedEnrollment({ enrollment: input, invitationCode: code, serviceUrl: 'https://enrollment.example.test/v1/enroll',
    fetchImpl: async (_url, options) => { sent = options; return new Response(JSON.stringify(invitation(input)), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(sent.headers['x-invite-code'], code);
  assert.ok(!sent.body.includes(code));
  await assert.rejects(api.requestHostedEnrollment({ enrollment: input, invitationCode: code, serviceUrl: 'https://enrollment.example.test/v1/enroll',
    fetchImpl: async () => new Response('{}', { status: 403 }) }), { code: 'HOSTED_INVITATION_REJECTED' });
});

test('a hosted request can finish after a slow but successful server installation', async () => {
  const input = request();
  const fetchImpl = async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return new Response(JSON.stringify(invitation(input)), { headers: { 'content-type': 'application/json' } });
  };
  const result = await api.requestHostedEnrollment({ enrollment: input, serviceUrl: 'https://enrollment.example.test/v1/enroll', fetchImpl });
  assert.equal(result.installationId, input.installationId);
});

test('hosted enrollment rejects insecure endpoints, oversized bodies and a different computer', async () => {
  const input = request(); let called = false;
  await assert.rejects(api.requestHostedEnrollment({ enrollment: input, serviceUrl: 'http://enrollment.example.test/v1/enroll', fetchImpl: async () => { called = true; } }), { code: 'HOSTED_SERVICE_INVALID' });
  assert.equal(called, false);
  await assert.rejects(api.requestHostedEnrollment({ enrollment: input, serviceUrl: 'https://enrollment.example.test/v1/enroll',
    fetchImpl: async () => new Response('x'.repeat(17000), { status: 200, headers: { 'content-type': 'application/json' } }) }), { code: 'HOSTED_RESPONSE_INVALID' });
  await assert.rejects(api.requestHostedEnrollment({ enrollment: input, serviceUrl: 'https://enrollment.example.test/v1/enroll',
    fetchImpl: async () => new Response(JSON.stringify({ ...invitation(input), installationId: randomUUID() }), { status: 200, headers: { 'content-type': 'application/json' } }) }), { code: 'HOSTED_RESPONSE_INVALID' });
});

test('hosted enrollment never accepts redirects, server errors or non-JSON responses', async () => {
  const input = request(), serviceUrl = 'https://enrollment.example.test/v1/enroll';
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://other.example.test/' } }), new Response(null, { status: 503 })]) {
    await assert.rejects(api.requestHostedEnrollment({ enrollment: input, serviceUrl, fetchImpl: async () => response }), { code: 'HOSTED_SERVICE_UNAVAILABLE' });
  }
  await assert.rejects(api.requestHostedEnrollment({ enrollment: input, serviceUrl, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'text/html' } }) }), { code: 'HOSTED_RESPONSE_INVALID' });
  await assert.rejects(api.requestHostedEnrollment({ enrollment: input, serviceUrl, fetchImpl: async () => { throw Error('network'); } }), { code: 'HOSTED_SERVICE_UNAVAILABLE' });
});

test('the hosted provider uses the trusted project service by default and permits an explicit override', async () => {
  const provider = await import('../distribution/hosted-provider.mjs');
  assert.equal(provider.HOSTED_SERVICE_URL, 'https://turbotang.top:29445/v1/enroll');
  assert.equal(typeof provider.createHostedProvider(), 'function');
  assert.equal(provider.createHostedProvider({ serviceUrl: null }), undefined);
  const input = request(); let calls = 0;
  const enabled = provider.createHostedProvider({ serviceUrl: 'https://enrollment.example.test/v1/enroll', fetchImpl: async () => {
    calls++; return new Response(JSON.stringify(invitation(input)), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal((await enabled(input)).installationId, input.installationId); assert.equal(calls, 1);
});
