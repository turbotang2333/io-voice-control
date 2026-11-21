import { request } from 'node:https';

/** Authenticated GET only. A reachable bridge with a reconnecting backend is not a broken tunnel. */
export function probeBridgeHealth({ url, token, ca, timeoutMs = 5000, signal }) {
  return new Promise(resolve => {
    let timer, req, settled = false, secureConnected = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    };
    try {
      const endpoint = new URL(url);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        finish('rejected'); return;
      }
      req = request(endpoint, { method: 'GET', ...(ca ? { ca } : {}), signal,
        headers: { authorization: `Bearer ${token}` } }, res => {
        res.on('error', () => finish('unreachable'));
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404 || res.statusCode >= 300 && res.statusCode < 400) {
          finish('rejected'); res.destroy(); req.destroy(); return;
        }
        let bytes = 0, body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2048) { finish('unreachable'); res.destroy(); return; }
          body += chunk;
        });
        res.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (res.statusCode === 200 && value.ok === true && value.status === 'ready') finish('ready');
            else if (res.statusCode === 503 && value.ok === false && value.status === 'reconnecting') finish('reconnecting');
            else finish('unreachable');
          } catch { finish('unreachable'); }
        });
      });
      // Absolute deadline also covers DNS lookup, TCP connection, and the TLS handshake.
      const transportFailure = () => secureConnected ? 'unreachable' : 'network_unavailable';
      timer = setTimeout(() => { finish(transportFailure()); req.destroy(); }, timeoutMs);
      req.on('socket', socket => {
        if (!socket.connecting && socket.authorized) secureConnected = true;
        else socket.once('secureConnect', () => { secureConnected = socket.authorized; });
      });
      req.on('error', error => {
        const certificateError = /^(CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|UNABLE_TO_GET_ISSUER_CERT_LOCALLY$)/.test(error?.code ?? '');
        finish(certificateError ? 'rejected' : transportFailure());
      });
      req.end();
    } catch { finish('unreachable'); }
  });
}

/** Recovers only the owned SSH process. Never changes ports, restarts shared services, or replays requests. */
export function createRelayHealthMonitor({ probeLocal, probePublic, restartRelay, getRelayState = () => null,
  onChange = () => {}, onCheck = () => {},
  intervalMs = 30000, failureThreshold = 3, cooldownMs = 120000, maxRecoveryAttempts = 3, now = Date.now }) {
  let stopped = false, timer, pending, running = false, failures = 0, successes = 0, attempts = 0;
  let lastRecovery = -Infinity, snapshot = { state: 'checking', recoveryAttempts: 0 };
  const abort = new AbortController();
  const publish = (state, nextRecoveryAt = null) => {
    const changed = state !== snapshot.state || attempts !== snapshot.recoveryAttempts;
    snapshot = { state, recoveryAttempts: attempts, checkedAt: new Date(now()).toISOString(), nextRecoveryAt };
    if (changed) { try { onChange({ ...snapshot }); } catch { /* Status storage must not stop recovery. */ } }
    try { onCheck({ ...snapshot }); } catch { /* Status storage must not stop recovery. */ }
    return { ...snapshot };
  };
  const probe = async fn => { try { return await fn(abort.signal); } catch { return 'unreachable'; } };
  function check() {
    if (stopped) return Promise.resolve({ state: 'stopped', recoveryAttempts: attempts });
    if (pending) return pending;
    pending = (async () => {
      const local = await probe(probeLocal);
      if (stopped) return publish('stopped');
      if (!['ready', 'reconnecting'].includes(local)) {
        failures = 0; successes = 0;
        return publish(local === 'rejected' ? 'configuration_error' : 'local_unavailable');
      }
      const remote = await probe(probePublic);
      if (stopped) return publish('stopped');
      if (['ready', 'reconnecting'].includes(remote)) {
        failures = 0;
        if (++successes >= 2) attempts = 0;
        return publish(local === 'reconnecting' || remote === 'reconnecting' ? 'backend_reconnecting' : 'ready');
      }
      successes = 0;
      if (remote === 'rejected') { failures = 0; return publish('configuration_error'); }
      let relay;
      try { relay = getRelayState(); } catch { /* Unknown process state retains normal health thresholds. */ }
      if (relay?.running === false && ['authentication_failed', 'host_key_failed', 'executable_missing', 'permission_denied'].includes(relay.lastExitReason)) {
        failures = 0; return publish('configuration_error');
      }
      // Without a working network, restarting SSH cannot help. Preserve its recovery budget until connectivity returns.
      if (remote === 'network_unavailable') { failures = 0; return publish('network_unavailable'); }
      failures = relay?.running === false ? failureThreshold : failures + 1;
      // Exhausting rapid retries must not leave an exited tunnel offline forever.
      // Keep probing, but slow further recovery attempts to at most once per ten minutes.
      const recoveryDelayMs = attempts < maxRecoveryAttempts ? cooldownMs : Math.max(cooldownMs, 600000);
      if (failures >= failureThreshold && now() - lastRecovery >= recoveryDelayMs) {
        attempts++; lastRecovery = now();
        const nextRecoveryAt = new Date(lastRecovery + (attempts < maxRecoveryAttempts ? cooldownMs : Math.max(cooldownMs, 600000))).toISOString();
        publish('relay_recovering', nextRecoveryAt);
        try { await restartRelay(); } catch { return publish(stopped ? 'stopped' : 'relay_unavailable'); }
        return publish(stopped ? 'stopped' : 'relay_recovering', stopped ? null : nextRecoveryAt);
      }
      return publish(attempts > 0 && attempts < maxRecoveryAttempts ? 'relay_recovering' : 'relay_unavailable',
        Number.isFinite(lastRecovery) ? new Date(lastRecovery + recoveryDelayMs).toISOString() : null);
    })().finally(() => { pending = undefined; });
    return pending;
  }
  async function tick() {
    await check();
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }
  return {
    check,
    start() { if (!running && !stopped) { running = true; void tick(); } },
    async stop() { stopped = true; clearTimeout(timer); abort.abort(); await pending; },
  };
}
