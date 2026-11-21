import { randomUUID } from 'node:crypto';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

/** Match SDK createPaseoClient, while exposing the SAME daemon's event subscription. */
export function createPaseoConnection(config, { Daemon = DaemonClient, createApi = createPaseoApi } = {}) {
  const daemon = new Daemon({ ...config, clientId: config.clientId ?? randomUUID(), clientType: 'cli' });
  const api = createApi(daemon), listeners = new Set();
  const unsubscribe = daemon.subscribeConnectionStatus(state => {
    for (const listener of listeners) listener(state);
  });
  return { ...api,
    connect: () => daemon.connect(), ensureConnected: () => daemon.ensureConnected(),
    getConnectionState: () => daemon.getConnectionState(),
    getServerId: () => daemon.getLastServerInfoMessage?.()?.serverId ?? null,
    supportsAgentCreation: () => {
      const features = daemon.getLastServerInfoMessage?.()?.features;
      return features?.creationLifecycle === true && features?.agentRequestReceipts === true;
    },
    subscribeConnectionStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      unsubscribe(); listeners.clear();
      try { await api.dispose(); } finally { await daemon.close(); }
    },
  };
}
