import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';

/** A configuration flag is never evidence of encryption. Verify the live peer before claiming readiness. */
export function probeSecureEndpoint({ publicBaseUrl, identity, timeoutMs = 5000, signal } = {}) {
  return new Promise(resolve => {
    let request, timer, settled = false;
    const finish = state => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ state, encryption: state === 'verified' ? 'verified' : 'unverified' });
    };
    try {
      const url = new URL(publicBaseUrl), cert = new X509Certificate(identity.cert);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') { finish('configuration_rejected'); return; }
      if (createHash('sha256').update(cert.raw).digest('hex') !== identity.certificateSha256) { finish('identity_rejected'); return; }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) { finish('configuration_rejected'); return; }
      request = https.get(new URL('/healthz', url), { ca: cert.toString(), minVersion: 'TLSv1.3', agent: false, signal,
        checkServerIdentity(host, peer) {
          const invalid = checkServerIdentity(host, peer);
          if (invalid) return invalid;
          if (createHash('sha256').update(peer.raw).digest('hex') !== identity.certificateSha256)
            return Object.assign(Error('SECURE_IDENTITY_CHANGED'), { code: 'ERR_TLS_CERT_PIN_MISMATCH' });
        } }, response => {
        let body = '', size = 0;
        if (response.statusCode !== 200) { finish('protocol_rejected'); response.destroy(); return; }
        response.setEncoding('utf8');
        response.on('data', chunk => {
          size += Buffer.byteLength(chunk);
          if (size > 2048) { finish('protocol_rejected'); response.destroy(); return; }
          body += chunk;
        });
        response.on('error', () => finish('network_unavailable'));
        response.on('end', () => {
          try { const result = JSON.parse(body); finish(result.ok === true && result.transport === 'tls-passthrough-v1' ? 'verified' : 'protocol_rejected'); }
          catch { finish('protocol_rejected'); }
        });
      });
      timer = setTimeout(() => { finish('network_unavailable'); request.destroy(); }, timeoutMs);
      request.on('error', error => finish(/^(CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_)/.test(error?.code ?? '') ? 'identity_rejected' : 'network_unavailable'));
    } catch { finish('configuration_rejected'); }
  });
}
