export function connectionChoiceView(status, selected) {
  const recovery = (status.ipRecoveryOptions ?? []).length > 0;
  const configured = ['configured', 'existing'].includes(status.phase) || recovery;
  return { showChoices: !configured, showConnection: configured || selected === 'project-hosted',
    showSelfHosted: recovery || (configured ? status.hosting === 'self-hosted' : selected === 'self-hosted') };
}

export function assistantStatus(status, backend) {
  const connection = (status.connections ?? []).find(item => item.backend === backend);
  if (connection?.ready) return { label: '已连接', kind: 'ready' };
  if (connection?.local === 'reconnecting' || connection?.wireless === 'reconnecting') return { label: '连接中', kind: 'checking' };
  if (connection) return { label: '连接中断', kind: 'error', detail: connectionDetail(connection) };
  if ((status.available ?? []).includes(backend)) return { label: '已检测', kind: 'detected',
    ...(['configured', 'existing'].includes(status.phase) ? { detail: '尚未加入当前连接。加入后如需在手机使用，请重新扫码。' } : {}) };
  return { label: '未检测到', kind: 'missing' };
}

export function assistantGuidance(available = []) {
  const names = available.filter(n => n === 'paseo' || n === 'codex').map(n => n === 'paseo' ? 'Paseo' : 'Codex');
  return names.length ? '已发现：' + names.join('、') + '。请确认已在助手中登录，然后点击连接；登录状态以实际连接结果为准。'
    : '请先安装、打开并登录 Paseo 或 Codex，再点击“刷新状态”。';
}

export function connectionView(status, hosting = 'project-hosted') {
  const configured = ['configured', 'existing'].includes(status.phase);
  const connections = status.connections ?? [];
  const ready = connections.filter(c => c.ready).length;
  const needsRepair = Boolean(status.secureError) || connections.some(c => c.local === 'rejected'
    || ['rejected', 'identity_rejected', 'protocol_rejected', 'configuration_rejected'].includes(c.wireless));
  const missingDetected = (status.available ?? []).some(backend => ['codex', 'paseo'].includes(backend)
    && !connections.some(connection => connection.backend === backend));
  const kind = !configured ? (['prepared', 'incomplete'].includes(status.phase) ? 'setup' : 'first')
    : ready ? (ready === connections.length && !missingDetected ? 'ready' : 'partial')
    : needsRepair ? 'repair' : connections.length ? 'disconnected' : 'repair';
  const copy = {
    first: ['准备连接', '确认助手已打开并登录。', '连接'],
    setup: ['准备连接', '请继续连接。', '继续连接'],
    ready: ['电脑连接正常', '', '检查连接'],
    partial: ['部分助手可以使用', '其余助手请检查连接。', '重新连接'],
    disconnected: ['连接暂时中断', '请检查电脑网络和助手。', '重新连接'],
    repair: ['需要检查连接', '请检查电脑网络和助手。', '重新连接'],
  }[kind];
  const canConnect = configured || (status.available?.length ?? 0) > 0;
  const canAddCodex = configured && status.connectionMode === 'secure' && !status.secureError
    && (status.available ?? []).includes('codex') && !connections.some(connection => connection.backend === 'codex');
  return { kind, title: copy[0], description: copy[1], connectLabel: copy[2], needsRepair,
    canAddCodex,
    showSetup: !configured && kind === 'setup',
    canConnect, canStart: canConnect && (status.phase !== 'prepared' || status.hostedEnrollmentAvailable === true && hosting === 'project-hosted'),
    canPair: configured && ready > 0 && status.pairingEnabled && status.pairingReady === true
      && (status.connectionMode !== 'secure' || status.encryption === 'verified'),
    phoneVerified: false };
}

export function createAutoCodexConnector(connect) {
  let attempted = false;
  return async status => {
    if (attempted || !connectionView(status).canAddCodex) return false;
    attempted = true;
    await connect();
    return true;
  };
}

export function connectionDetail(item) {
  if (item.ready) return '连接正常';
  if (item.wireless === 'identity_rejected') return '电脑身份校验未通过，请检查中转设置';
  if (['protocol_rejected', 'configuration_rejected'].includes(item.wireless)) return '中转配置需要检查';
  if (item.local === 'rejected' || item.wireless === 'rejected') return '访问被拒绝，请检查连接设置';
  if (item.local === 'reconnecting') return '助手正在恢复连接';
  if (item.local !== 'ready') return '请打开助手并检查登录状态';
  if (item.wireless === 'reconnecting') return '手机访问入口正在恢复';
  return '手机访问入口暂时不可达';
}
