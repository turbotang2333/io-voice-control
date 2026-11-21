import { isAbsolute } from 'node:path';

// An opt-in transport to the SAME app-server used by the desktop, never a public listener.
export function validateSharedConnection(value) {
  const invalid = () => { throw Object.assign(new Error('INVALID_SHARED_CONNECTION'), { code: 'INVALID_SHARED_CONNECTION' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['endpoint', 'tokenFile'].includes(k))
    || typeof value.endpoint !== 'string' || typeof value.tokenFile !== 'string' || !isAbsolute(value.tokenFile)) invalid();
  let url;
  try { url = new URL(value.endpoint); } catch { invalid(); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || Number(url.port) < 1024 || url.username || url.password || url.search || url.hash
    || !['/', '/rpc'].includes(url.pathname)) invalid();
  return Object.freeze({ endpoint: value.endpoint, tokenFile: value.tokenFile });
}
