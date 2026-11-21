import { connectionView, connectionChoiceView, assistantStatus, assistantGuidance, createAutoCodexConnector } from './view.js';
const el = id => document.getElementById(id);
let pending = false, expiresAt = 0, lastStatus, refreshPending, statusUnavailable = false, selfBundleId, selectedHosting = null;
const autoConnectCodex = createAutoCodexConnector(() => connectNow(el('connect')));
function notice(text = '') { el('notice').textContent = text; el('notice').hidden = !text; }
async function api(path, body) {
  const response = await fetch('/api/' + path, { signal: AbortSignal.timeout(['connect', 'self-hosted-command', 'self-hosted-pair', 'self-hosted-prepare', 'self-hosted-finish', 'self-hosted-change-ip'].includes(path) ? 180000 : 20000), ...(body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw Error(value.error || '操作未完成，请重试。'); return value;
}
function render(status) {
  lastStatus = status;
  const view = connectionView(status, 'project-hosted'), configured = ['configured', 'existing'].includes(status.phase);
  const secure = status.connectionMode === 'secure', recovery = status.ipRecoveryOptions ?? [];
  const choices = connectionChoiceView(status, selectedHosting);
  el('connection-choices').hidden = !choices.showChoices;
  el('connection-panel').hidden = !choices.showConnection;
  el('self-hosted').hidden = !choices.showSelfHosted;
  for (const [id, hosting] of [['choose-project', 'project-hosted'], ['choose-self', 'self-hosted']]) {
    el(id).setAttribute('aria-pressed', String(selectedHosting === hosting));
    el(id).disabled = pending || statusUnavailable;
  }
  el('self-hosted-setup').hidden = secure;
  el('self-hosted-update').hidden = !secure || status.hosting !== 'self-hosted' || !status.ipChangeAvailable || !!recovery.length;
  el('self-hosted-update-unavailable').hidden = !secure || status.hosting !== 'self-hosted' || status.ipChangeAvailable || !!recovery.length;
  el('self-hosted-recovery').hidden = !recovery.length;
  if (recovery.length) {
    const select = el('self-backup'), previous = select.value;
    select.replaceChildren(...recovery.map((entry, index) => { const option = document.createElement('option'); option.value = entry.id;
      option.textContent = `保留配置 ${index + 1}（${new Date(entry.modified).toLocaleString()}）`; return option; }));
    if (recovery.some(entry => entry.id === previous)) select.value = previous;
  }
  for (const id of ['self-bootstrap-install', 'self-bootstrap-pair', 'self-prepare', 'self-finish', 'self-change-ip', 'self-restore']) el(id).disabled = pending || statusUnavailable;
  el('service-notice').hidden = configured;
  el('preview').hidden = !status.preview;
  el('status-title').textContent = view.title; el('status-description').textContent = view.description;
  document.body.dataset.state = view.kind;
  el('connect').textContent = view.canAddCodex ? '添加 Codex' : configured ? view.connectLabel : '连接并配对';
  el('connect').disabled = pending || statusUnavailable || !view.canStart;
  el('connect').hidden = (view.canPair && view.kind !== 'partial') || !el('service-confirm').hidden;
  el('connect').className = 'primary';
  el('pair').hidden = !view.canPair || !el('qr-box').hidden;
  el('pair').className = 'primary';
  el('pair').disabled = el('regenerate').disabled = pending || statusUnavailable || !view.canPair;
  el('encryption-info').hidden = !configured || status.connectionMode !== 'secure';
  el('encryption-info').textContent = status.secureError ? '加密连接配置需要修复，原设置已保留。'
    : status.encryption === 'verified' ? '加密通道检查通过。手机首次扫码时还会校验电脑身份。'
    : '加密通道尚未通过检查。连接恢复后再扫码。';
  el('detected').hidden = configured || (status.available?.length ?? 0) > 0;
  el('detected').textContent = assistantGuidance(status.available);
  for (const backend of ['codex', 'paseo']) {
    const result = assistantStatus(status, backend), label = el(backend + '-status'), detail = el(backend + '-detail');
    label.textContent = result.label; label.dataset.state = result.kind;
    detail.hidden = !result.detail; detail.textContent = result.detail ?? '';
  }
  el('pair-instructions').hidden = !view.canPair;
  el('pair-hint').hidden = !configured;
  el('pair-hint').textContent = view.canPair ? ''
    : status.connections?.some(c => c.ready) ? '可继续使用已配对的正常助手。配对入口恢复后，可添加新手机。'
    : '连接恢复后可扫码配对。已配对的手机无需重复设置。';
  if (!view.canPair && !el('qr-box').hidden) closeQr();
  tick();
}
async function refresh(force = false) {
  if (pending) return;
  if (refreshPending) return refreshPending;
  el('refresh').setAttribute('aria-busy', 'true');
  refreshPending = (async () => {
    try {
      const status = await api(force ? 'status?refresh=1' : 'status');
      if (statusUnavailable) notice(); statusUnavailable = false; render(status);
    } catch {
      statusUnavailable = true;
      notice('暂时无法读取电脑连接器状态。请确认连接器仍在运行，再点“刷新状态”。原设置已保留。');
      if (lastStatus) render(lastStatus);
      else { el('status-title').textContent = '暂时无法检查连接'; el('status-description').textContent = '请检查连接器是否仍在运行。'; }
    } finally { refreshPending = null; el('refresh').removeAttribute('aria-busy'); }
    if (!pending && !statusUnavailable && lastStatus) void autoConnectCodex(lastStatus);
  })();
  return refreshPending;
}
async function act(button, path, body, done) {
  if (pending || statusUnavailable) return;
  if (refreshPending) await refreshPending;
  if (pending || statusUnavailable) return;
  pending = true; notice(); button.setAttribute('aria-busy', 'true'); if (lastStatus) render(lastStatus);
  try { const value = await api(path, body); if (done) done(value); }
  catch (error) { notice(error.name === 'TimeoutError' ? '操作结果尚未确认，请检查状态后再继续。' : error.message); }
  finally { pending = false; button.removeAttribute('aria-busy'); await refresh(); }
}
el('refresh').onclick = () => refresh(true);
el('choose-project').onclick = () => {
  selectedHosting = 'project-hosted'; el('service-confirm').hidden = false; if (lastStatus) render(lastStatus);
};
el('choose-self').onclick = () => {
  selectedHosting = 'self-hosted'; el('service-confirm').hidden = true; if (lastStatus) render(lastStatus);
};
function connectNow(button) {
  const needsInvitation = lastStatus?.connectionMode !== 'secure';
  const invitationCode = needsInvitation ? el('invitation-code').value.trim() : undefined;
  if (needsInvitation && !/^rnp-[A-Za-z0-9_-]{43}$/.test(invitationCode)) { notice('请输入完整的测试码。'); return; }
  el('service-confirm').hidden = true;
  const addingCodex = connectionView(lastStatus).canAddCodex;
  return act(button, 'connect', { hosting: 'project-hosted', enableCodex: addingCodex, ...(invitationCode ? { invitationCode } : {}) }, value => {
    el('invitation-code').value = '';
    if (value.needsConfiguration) notice('连接尚未完成，请检查网络后重试。');
    if (value.blocked?.length) notice(value.blocked.map(item => item.reason === 'CODEX_CLOSE_REQUIRED'
      ? 'Codex：请先结束运行任务并退出桌面，再点“重新连接”。连接器会重新打开 Codex。'
      : (item.backend === 'codex' ? 'Codex' : 'Paseo') + '：暂时无法启动，请检查助手后重试。').join(' '));
    if (value.restartRequired) notice('Codex 已加入配置。请重启电脑，然后打开连接器并检查 Codex 状态。');
    else if (addingCodex && !value.needsConfiguration && !value.blocked?.length)
      notice('如果手机尚未配置 Codex，连接就绪后请重新扫码。');
  });
}
el('connect').onclick = () => {
  const configured = ['configured', 'existing'].includes(lastStatus?.phase);
  if (!configured || lastStatus?.connectionMode !== 'secure') { el('service-confirm').hidden = false; el('connect').hidden = true; return; }
  void connectNow(el('connect'));
};
el('confirm-connect').onclick = () => void connectNow(el('confirm-connect'));
el('cancel-connect').onclick = () => { el('service-confirm').hidden = true; if (lastStatus) render(lastStatus); };
el('self-bootstrap-install').onclick = () => void act(el('self-bootstrap-install'), 'self-hosted-command', { host: el('self-bootstrap-host').value.trim().toLowerCase() }, value => {
  el('self-bootstrap-command').value = value.command; el('self-bootstrap-command-box').hidden = false;
  el('self-bootstrap-command').focus(); el('self-bootstrap-command').select();
  el('self-bootstrap-progress').textContent = '等待服务器运行安装命令…';
  notice('命令已选中，请复制到服务器运行。'); void refreshSelfHostedProgress();
});
el('self-bootstrap-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(el('self-bootstrap-command').value); notice('命令已复制，请粘贴到服务器终端运行。'); }
  catch { el('self-bootstrap-command').focus(); el('self-bootstrap-command').select(); notice('命令已选中，请手动复制。'); }
};
el('self-bootstrap-pair').onclick = () => void act(el('self-bootstrap-pair'), 'self-hosted-pair', { pairingInfo: el('self-bootstrap-code').value.trim() }, value => {
  el('self-bootstrap-code').value = '';
  notice(value.starting === false ? '配置已保存，但连接尚未启动。请检查服务器和电脑连接后重试。' : '正在连接。通过加密检查后，请在手机扫码配对。');
});
async function refreshSelfHostedProgress() {
  try {
    const { state } = await api('self-hosted-progress');
    if (state === 'waiting' || state === 'installing') { el('self-bootstrap-progress').textContent = state === 'installing' ? '已找到服务器，正在安装并连接…' : '等待服务器运行安装命令…'; setTimeout(refreshSelfHostedProgress, 3000); }
    else if (state === 'connected') { el('self-bootstrap-command').value = ''; notice('服务器已配置，正在检查连接。'); void refresh(true); }
    else if (state === 'configured') notice('配置已保存，请检查连接状态后重试。');
    else if (state === 'expired' || state === 'failed') { el('self-bootstrap-command').value = ''; el('self-bootstrap-progress').textContent = '自动连接未完成。若服务器已安装完成，请使用下方手动配置方式恢复；否则请重新生成命令。'; }
  } catch { el('self-bootstrap-progress').textContent = '暂时无法检查进度，请确认连接器仍在运行。'; }
}
el('self-prepare').onclick = () => {
  if (!el('self-key-confirm').checked) { notice('请先通过可信的服务器登录方式核对 SSH 公钥。'); return; }
  void act(el('self-prepare'), 'self-hosted-prepare', { ip: el('self-ip').value.trim().toLowerCase(), hostKey: el('self-host-key').value.trim(),
    publicPort: Number(el('self-public-port').value), sshPort: Number(el('self-ssh-port').value) }, value => {
    selfBundleId = value.bundleId; el('self-bundle-path').textContent = value.directory; el('self-bundle').hidden = false;
    notice('配置包已生成。请先完成服务器安装和端口开放。');
  });
};
el('self-finish').onclick = () => {
  if (!selfBundleId) { notice('请先生成服务器配置包。'); return; }
  void act(el('self-finish'), 'self-hosted-finish', { bundleId: selfBundleId }, value => notice(value.starting === false
    ? '配置已保存，但连接尚未启动。请检查服务器和电脑连接后重试。' : '正在连接。通过加密检查后，请在手机扫码配对。'));
};
el('self-change-ip').onclick = () => void act(el('self-change-ip'), 'self-hosted-change-ip', { ip: el('self-new-ip').value.trim() }, value => {
  el('self-new-ip').value = ''; notice(value.starting === false ? 'IP 已更新，但连接尚未启动。请检查服务器后重试，连接成功后重新扫码。'
    : 'IP 已更新，正在重新连接。连接通过检查后，请在手机重新扫码。');
});
el('self-restore').onclick = () => void act(el('self-restore'), 'self-hosted-restore', { backupId: el('self-backup').value }, () => {
  notice('旧配置已恢复。请检查服务器地址，并重新连接。');
});
function pairing(button) {
  act(button, 'pair', {}, value => {
    if (!/^data:image\/png;base64,/.test(value.image)) throw Error('配对码无法显示，请重新生成。');
    el('qr').src = value.image; el('qr').hidden = false; expiresAt = value.expiresAt;
    el('qr-box').hidden = false; el('pair').hidden = true; tick();
    el('qr-profiles').textContent = '本次配对包含：' + (lastStatus.connections ?? []).filter(c => c.ready).map(c => c.backend === 'codex' ? 'Codex' : 'Paseo').join('、') + '。';
    el('qr-box').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}
function closeQr() { el('qr-box').hidden = true; el('qr').hidden = true; el('qr').removeAttribute('src'); expiresAt = 0; if (lastStatus) render(lastStatus); }
el('pair').onclick = () => pairing(el('pair')); el('regenerate').onclick = () => pairing(el('regenerate')); el('close-qr').onclick = closeQr;
function tick() {
  if (!expiresAt) return;
  if (lastStatus?.pairingState === 'claimed') {
    el('qr').hidden = true; el('qr-title').textContent = '手机已读取配对信息';
    el('expiry').textContent = '请在手机上完成确认；以手机显示的结果为准。'; return;
  }
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  el('qr-title').textContent = seconds ? '用雷鸟 APP 扫描' : '二维码已过期';
  el('expiry').textContent = seconds ? `${seconds} 秒内有效` : '请重新生成二维码。'; el('qr').hidden = !seconds;
}
refresh(); setInterval(() => refresh(), 12000); setInterval(tick, 1000);
let searchAction = false;
async function refreshSearch() {
  try {
    const state = await api('search-package');
    const busy = ['checking', 'downloading', 'installing', 'verifying'].includes(state.state);
    const mb = state.total ? Math.ceil(state.total / 1024 / 1024) : 0;
    const percent = state.total ? Math.min(100, Math.floor(state.received / state.total * 100)) : 0;
    const statusText = {
      checking: '正在检查扩展包…',
      downloading: `正在下载 ${percent}%`,
      installing: '正在安装…',
      verifying: '正在试运行本地搜索模型…',
      error: state.error === 'SEARCH_MODEL_FAILED' ? '本地搜索模型未能运行，请重试。' : '下载或安装未完成，请重试。',
    };
    const available = `未安装，下载约 ${mb} MB${state.expandedBytes ? `，安装后约占用 ${Math.ceil(state.expandedBytes / 1024 / 1024)} MB` : ''}。`;
    const unavailable = state.availability === 'offline' ? '暂时无法检查扩展包，请稍后再试。' : '扩展包暂未上线。';
    const message = statusText[state.state] ?? (state.ready ? '已就绪' : state.installed ? '已下载，等待检查。' : state.configured ? available : unavailable);
    if (el('search-status').textContent !== message) el('search-status').textContent = message;
    el('search-install').hidden = state.ready || !(state.configured || state.installed) || busy;
    el('search-install').textContent = state.installed ? '检查并启用' : '下载并启用';
    el('search-remove').hidden = !state.installed || busy;
    el('search-progress').hidden = !busy;
    if (state.state === 'downloading') el('search-progress').value = percent;
    else el('search-progress').removeAttribute('value');
    el('search-install').disabled = el('search-remove').disabled = searchAction;
  } catch { el('search-status').textContent = '暂时无法检查智能搜索状态。'; }
}
async function changeSearch(action) {
  if (searchAction) return;
  searchAction = true;
  try { await api(action, {}); } catch (error) { notice(error.message); }
  finally { searchAction = false; await refreshSearch(); }
}
el('search-install').onclick = () => void changeSearch('search-install');
el('search-remove').onclick = () => void changeSearch('search-remove');
void refreshSearch(); setInterval(refreshSearch, 1500);
