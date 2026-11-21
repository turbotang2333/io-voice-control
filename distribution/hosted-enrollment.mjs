import { validHostname, validInstallationId, validateSecureInvitation, validateSshPublicKey } from '../secure-link/config.mjs';

const fail = code => Object.assign(Error(code), { code });

/** Only public information needed to allocate a hosted relay leaves this computer. */
export function createHostedEnrollment(value) {
  try {
    if (!value || value.version !== 1 || !validInstallationId(value.installationId)
      || !Array.isArray(value.requestedBackends) || value.requestedBackends.length < 1 || value.requestedBackends.length > 2
      || new Set(value.requestedBackends).size !== value.requestedBackends.length
      || value.requestedBackends.some(name => !['paseo', 'codex'].includes(name))) throw Error();
    return { version: 1, installationId: value.installationId, requestedBackends: [...value.requestedBackends],
      sshPublicKey: validateSshPublicKey(value.sshPublicKey) };
  } catch { throw fail('HOSTED_ENROLLMENT_INVALID'); }
}

/** A response is accepted only for the exact local enrollment and the hosted secure format. */
export function validateHostedResponse(value, enrollment) {
  try {
    const request = createHostedEnrollment(enrollment);
    const safe = validateSecureInvitation(value, request.installationId);
    if (safe.version !== 3 || safe.hosting !== 'project-hosted' || safe.backends.length !== request.requestedBackends.length
      || safe.backends.some(name => !request.requestedBackends.includes(name))) throw Error();
    return safe;
  } catch { throw fail('HOSTED_RESPONSE_INVALID'); }
}

/** serviceUrl must come from trusted application configuration, never an untrusted page or invitation. */
export async function requestHostedEnrollment({ enrollment, invitationCode, serviceUrl, fetchImpl = fetch } = {}) {
  const request = createHostedEnrollment(enrollment);
  if (invitationCode !== undefined && !/^rnp-[A-Za-z0-9_-]{43}$/.test(invitationCode)) throw fail('HOSTED_INVITATION_REJECTED');
  let url;
  try {
    url = new URL(serviceUrl);
    if (url.protocol !== 'https:' || !validHostname(url.hostname) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/v1/enroll') throw Error();
  } catch { throw fail('HOSTED_SERVICE_INVALID'); }
  let response;
  try {
    response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(invitationCode ? { 'x-invite-code': invitationCode } : {}) }, body: JSON.stringify(request), signal: AbortSignal.timeout(120000) });
  } catch { throw fail('HOSTED_SERVICE_UNAVAILABLE'); }
  if (response.status === 403) throw fail('HOSTED_INVITATION_REJECTED');
  if (!response.ok) throw fail('HOSTED_SERVICE_UNAVAILABLE');
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw fail('HOSTED_RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel().catch(() => {}); throw Error(); }
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
    return validateHostedResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), request);
  } catch { throw fail('HOSTED_RESPONSE_INVALID'); }
}
