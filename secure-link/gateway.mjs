import https from 'node:https';
import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { handlePairingRequest } from '../bridge/pairing-http.mjs';

const fail = code => Object.assign(Error(code), { code });
const paths = new Map([
  ['/healthz', 'GET'], ['/v1/chat/completions', 'POST'], ['/v1/navigation/session', 'POST'],
  ['/v1/shortcuts/resolve', 'POST'], ['/v1/shortcuts/select', 'POST'],
]);

/** TLS terminates on the user's computer. Only authenticated local backend APIs are forwarded. */
export function createDesktopGateway({ identity, hostname, backends, pairing, getBackends } = {}) {
  let certificate;
  try {
    certificate = new X509Certificate(identity.cert);
    if (createHash('sha256').update(certificate.raw).digest('hex') !== identity.certificateSha256
      || !(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname))) throw Error();
  } catch { throw fail('SECURE_IDENTITY_INVALID'); }
  if (!backends || !Object.keys(backends).length || Object.keys(backends).some(key => !['paseo', 'codex'].includes(key))
    || Object.values(backends).some(value => !Number.isInteger(value?.port) || value.port < 1024 || value.port > 65535 || !value.ca
      || typeof value.token !== 'string' || !value.token || typeof value.upstreamToken !== 'string' || !value.upstreamToken)) throw fail('SECURE_BACKENDS_INVALID');
  const clients = new Set(), sockets = new Set();
  const server = https.createServer({ pfx: identity.pfx, passphrase: identity.passphrase, minVersion: 'TLSv1.3', handshakeTimeout: 10000 }, async (request, response) => {
    const reply = (status, code) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify({ error: { code } }));
    };
    let host;
    try { host = new URL('https://' + request.headers.host).hostname; } catch { reply(400, 'SECURE_HOST_INVALID'); return; }
    if (host.toLowerCase() !== hostname.toLowerCase() || request.headers['transfer-encoding'] && request.headers['content-length']) { reply(400, 'SECURE_HOST_INVALID'); return; }
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"ok":true,"transport":"tls-passthrough-v1"}'); return;
    }
    const match = /^\/(paseo|codex)(\/[^?#]*)$/.exec(request.url ?? '');
    let selected = match && backends[match[1]];
    if (match && !selected && getBackends) {
      try {
        const candidate = getBackends()?.[match[1]];
        if (candidate && Number.isInteger(candidate.port) && candidate.port >= 1024 && candidate.port <= 65535 && candidate.ca
          && typeof candidate.token === 'string' && candidate.token && typeof candidate.upstreamToken === 'string' && candidate.upstreamToken) selected = candidate;
      } catch { /* Keep the existing route available if reloading fails. */ }
    }
    if (!match || !selected) { reply(404, 'SECURE_ROUTE_NOT_FOUND'); return; }
    const [, backend, path] = match;
    if (pairing && ['/pair', '/v1/pairing/claim'].includes(path)) {
      request.url = path;
      try { if (!await handlePairingRequest(request, response, pairing)) reply(405, 'METHOD_NOT_ALLOWED'); }
      catch { reply(503, 'PAIRING_UNAVAILABLE_NOW'); }
      return;
    }
    if (paths.get(path) !== request.method) { reply(404, 'SECURE_ROUTE_NOT_FOUND'); return; }
    const expected = Buffer.from('Bearer ' + selected.token), supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, 'UNAUTHORIZED'); return; }
    const headers = {};
    for (const key of ['authorization', 'content-type', 'content-length', 'idempotency-key', 'x-navigation-owner', 'x-navigation-epoch', 'x-navigation-session', 'x-navigation-generation']) {
      if (request.headers[key] !== undefined) headers[key] = request.headers[key];
    }
    headers.authorization = 'Bearer ' + selected.upstreamToken;
    const upstream = https.request({ hostname: '127.0.0.1', port: selected.port, ca: selected.ca,
      path, method: request.method, headers, agent: false }, incoming => {
      const outgoing = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (incoming.headers['content-type']) outgoing['content-type'] = incoming.headers['content-type'];
      response.writeHead(incoming.statusCode, outgoing); response.flushHeaders();
      incoming.on('error', () => response.destroy()); incoming.pipe(response);
    });
    clients.add(upstream); upstream.once('close', () => clients.delete(upstream));
    upstream.on('error', () => reply(503, 'SECURE_BACKEND_OFFLINE'));
    upstream.setTimeout(300000, () => upstream.destroy());
    request.on('aborted', () => upstream.destroy());
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.maxHeadersCount = 32;
  server.maxConnections = 128;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const closeHttpConnections = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { closeHttpConnections(); for (const socket of sockets) socket.destroy(); };
  server.on('connect', (request, socket) => socket.destroy()); server.on('upgrade', (request, socket) => socket.destroy());
  server.once('close', () => { for (const client of clients) client.destroy(); });
  return server;
}
