import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { createHostedEnrollment } from '../distribution/hosted-enrollment.mjs';
import { validHostname } from '../secure-link/config.mjs';

const fail = () => Object.assign(Error('SELF_HOSTED_BOOTSTRAP_FAILED'), { code: 'SELF_HOSTED_BOOTSTRAP_FAILED' });
const fingerprint = cert => createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
function validateInfo(value, allowLoopback = false) {
  if (!value || value.version !== 1 || !(isIP(value.host) === 4 || validHostname(value.host)) || value.host === '0.0.0.0'
    || !allowLoopback && value.host.startsWith('127.') || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !/^[A-Za-z0-9_-]{43}$/.test(value.secret ?? '') || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
    || typeof value.certificate !== 'string' || value.certificate.length > 8192) throw fail();
  let certificate;
  try {
    const raw = Buffer.from(value.certificate, 'base64');
    if (raw.toString('base64') !== value.certificate) throw fail();
    certificate = new X509Certificate(raw);
  } catch { throw fail(); }
  if (fingerprint(certificate.raw) !== value.fingerprint || !(isIP(value.host) ? certificate.checkIP(value.host) : certificate.checkHost(value.host))) throw fail();
  return { version: 1, host: value.host, port: value.port, secret: value.secret, fingerprint: value.fingerprint, certificate: certificate.raw.toString('base64') };
}
export function createPairingInformation({ host, port, cert, secret, allowLoopback = false } = {}) {
  const certificate = new X509Certificate(cert);
  return validateInfo({ version: 1, host, port, secret, fingerprint: fingerprint(certificate.raw), certificate: certificate.raw.toString('base64') }, allowLoopback);
}
export function encodePairingInformation(value, allowLoopback = false) {
  return 'RNP1-' + Buffer.from(JSON.stringify(validateInfo(value, allowLoopback))).toString('base64url');
}
export function decodePairingInformation(value, allowLoopback = false) {
  if (typeof value !== 'string' || !/^RNP1-[A-Za-z0-9_-]{1,12000}$/.test(value)) throw fail();
  try {
    const payload = value.slice(5), raw = Buffer.from(payload, 'base64url');
    if (raw.toString('base64url') !== payload) throw fail();
    return validateInfo(JSON.parse(raw.toString('utf8')), allowLoopback);
  } catch { throw fail(); }
}

/** The caller must supply an already-authorized installer that accepts only a validated enrollment. */
export function createBootstrapServer({ pfx, passphrase, secret, install, expiresAt = Date.now() + 300000, now = Date.now } = {}) {
  if (!pfx || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? '') || typeof install !== 'function' || !Number.isFinite(expiresAt)) throw fail();
  const expected = Buffer.from(secret), limit = 16384; let claimed = false;
  const server = https.createServer({ pfx, passphrase, minVersion: 'TLSv1.2' }, (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const denied = () => { if (!res.headersSent) res.writeHead(403); res.end(); };
    const supplied = Buffer.from(typeof req.headers['x-pairing-code'] === 'string' ? req.headers['x-pairing-code'] : '');
    if (req.method !== 'POST' || req.url !== '/v1/bootstrap' || claimed || now() >= expiresAt
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { denied(); return; }
    req.socket.setTimeout(120000);
    let size = 0, chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { chunks = []; req.destroy(); } else chunks.push(chunk); });
    req.on('end', async () => {
      let enrollment;
      try { enrollment = createHostedEnrollment(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { denied(); return; }
      if (claimed || now() >= expiresAt) { denied(); return; }
      claimed = true;
      server.emit('bootstrapClaimed');
      try {
        const result = await install(enrollment);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
      } catch { res.writeHead(500); res.end(); }
    });
    req.on('error', () => {});
  });
  server.maxConnections = 32;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.setTimeout(15000, socket => socket.destroy());
  return server;
}

export async function requestBootstrap({ info, enrollment, allowLoopback = false, connectHost, timeoutMs = 120000, connectTimeoutMs = 5000, onAuthenticated } = {}) {
  const safe = validateInfo(info, allowLoopback), request = createHostedEnrollment(enrollment);
  if (connectHost !== undefined && (!allowLoopback || connectHost !== '127.0.0.1')) throw fail();
  return new Promise((resolve, reject) => {
    const req = https.request({ host: connectHost ?? safe.host, port: safe.port, path: '/v1/bootstrap', method: 'POST', agent: false,
      ca: new X509Certificate(Buffer.from(safe.certificate, 'base64')).toString(), minVersion: 'TLSv1.2',
      headers: { 'content-type': 'application/json', 'x-pairing-code': safe.secret },
      checkServerIdentity(_host, cert) { return tls.checkServerIdentity(safe.host, cert) || (fingerprint(cert.raw) !== safe.fingerprint ? fail() : undefined); } }, res => {
      let size = 0, chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 16384) res.destroy(); else chunks.push(chunk); });
      res.on('end', () => { try { if (res.statusCode !== 200) throw fail(); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(Error('SELF_HOSTED_BOOTSTRAP_RESPONSE'), { code: 'SELF_HOSTED_BOOTSTRAP_RESPONSE' })); } });
      res.on('error', () => reject(fail()));
    });
    const connectTimer = setTimeout(() => req.destroy(fail()), connectTimeoutMs);
    connectTimer.unref?.();
    req.on('socket', socket => socket.once('secureConnect', () => { clearTimeout(connectTimer); try { onAuthenticated?.(); } catch {} }));
    req.once('close', () => clearTimeout(connectTimer));
    req.setTimeout(timeoutMs, () => req.destroy(fail()));
    req.on('error', () => reject(fail()));
    req.end(JSON.stringify(request));
  });
}
