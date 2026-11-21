import { isIP } from 'node:net';
import { createHostedEnrollment, validateHostedResponse } from '../distribution/hosted-enrollment.mjs';

const fail = code => Object.assign(Error(code), { code });
const maxBytes = 16384;
const allowedFields = new Set(['version', 'installationId', 'requestedBackends', 'sshPublicKey']);

function readRequest(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', errorEvent); request.off('aborted', aborted);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) return finish(fail('TOO_LARGE'));
      chunks.push(bytes);
    };
    const end = () => finish(null, Buffer.concat(chunks, size));
    const errorEvent = () => finish(fail('BAD_REQUEST'));
    const aborted = () => finish(fail('BAD_REQUEST'));
    const timer = setTimeout(() => { finish(fail('BAD_REQUEST')); request.destroy(); }, timeoutMs);
    timer.unref(); request.on('data', data); request.once('end', end); request.once('error', errorEvent); request.once('aborted', aborted);
  });
}

/** A TLS-only request adapter. The injected provisioner must enforce durable allocation and idempotency. */
export function createHostedEnrollmentHandler({ provision, authorize, maxConcurrent = 4, maxRequestsPerMinute = 10, maxGlobalRequestsPerMinute = 100,
  maxClients = 4096, timeoutMs = 10000, now = Date.now } = {}) {
  if (typeof provision !== 'function' || authorize !== undefined && typeof authorize !== 'function' || typeof now !== 'function' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128
    || !Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1 || maxRequestsPerMinute > 10000
    || !Number.isInteger(maxGlobalRequestsPerMinute) || maxGlobalRequestsPerMinute < 1 || maxGlobalRequestsPerMinute > 100000
    || !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 100000 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw fail('HOSTED_SERVER_INVALID');
  const clients = new Map(); let active = 0, globalWindow = null;
  const send = (response, status, value) => {
    if (response.destroyed || response.headersSent) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  return async function handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/v1/enroll') return send(response, 404, { error: 'not_found' });
    if (request.socket?.encrypted !== true || !isIP(request.socket?.remoteAddress ?? '')) return send(response, 400, { error: 'invalid_request' });
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) return send(response, 415, { error: 'invalid_content_type' });
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return send(response, 413, { error: 'too_large' });
    const time = now(), ip = request.socket.remoteAddress;
    if (!globalWindow || time - globalWindow.start >= 60000 || time < globalWindow.start) globalWindow = { start: time, count: 0 };
    if (globalWindow.count >= maxGlobalRequestsPerMinute) return send(response, 429, { error: 'rate_limited' });
    for (const [address, record] of clients) if (time - record.start >= 60000) clients.delete(address);
    let record = clients.get(ip);
    if (!record) { if (clients.size >= maxClients) return send(response, 429, { error: 'rate_limited' }); record = { start: time, count: 0 }; clients.set(ip, record); }
    if (record.count >= maxRequestsPerMinute) return send(response, 429, { error: 'rate_limited' });
    record.count++; globalWindow.count++;
    if (active >= maxConcurrent) return send(response, 503, { error: 'temporarily_unavailable' });
    active++;
    try {
      let value;
      try {
        const bytes = await readRequest(request, timeoutMs);
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowedFields.has(key))) throw fail('BAD_REQUEST');
        value = createHostedEnrollment(value);
      } catch (error) { return send(response, error.code === 'TOO_LARGE' ? 413 : 400, { error: error.code === 'TOO_LARGE' ? 'too_large' : 'invalid_request' }); }
      try {
        if (authorize && await authorize(value, request.headers['x-invite-code']) !== true) return send(response, 403, { error: 'invitation_rejected' });
        return send(response, 200, validateHostedResponse(await provision(value), value));
      }
      catch { return send(response, 503, { error: 'temporarily_unavailable' }); }
    } finally { active--; }
  };
}
