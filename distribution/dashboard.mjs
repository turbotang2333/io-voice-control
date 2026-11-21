import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';

const androidReleases = 'https://github.com/turbotang2333/io-voice-control/releases';
let androidDownloadQr;
const assets = { '/': ['ui/index.html', 'text/html; charset=utf-8'], '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'], '/view.js': ['ui/view.js', 'text/javascript; charset=utf-8'], '/style.css': ['ui/style.css', 'text/css; charset=utf-8'] };
const errorMessages = {
  CONNECTOR_EXISTING_CONFIGURATION: '这台电脑已有连接配置，已保留。请使用原连接器检查或更新。',
  CONNECTOR_ALREADY_PREPARED: '这台电脑已准备好，请继续导入接入文件。',
  CONNECTOR_INVITATION_INVALID: '接入文件不属于这台电脑，或内容不完整，请向试用管理员重新领取。',
  CONNECTOR_INVITATION_ALREADY_IMPORTED: '已导入过其他接入文件，当前连接保持不变，请联系试用管理员核对。',
  CONNECTOR_NOT_READY: '电脑连接尚未就绪，请先检查 Paseo 或 Codex 的登录和连接状态。',
  CODEX_CLOSE_REQUIRED: '请先结束 Codex 的运行任务并退出桌面，再点启动连接。连接器会重新打开 Codex。',
  PAIRING_BUSY: '配对正在处理中，请稍后重试。',
  SECURE_INVITATION_INVALID: '接入文件不属于这台电脑，或内容不完整，请重新获取。',
  SECURE_CONFIGURATION_EXISTS: '已有加密连接配置，现有设置已保留；暂不支持直接更换。',
  SECURE_CONFIGURATION_INVALID: '加密连接配置需要修复，现有设置已保留。',
  SECURE_IDENTITY_REJECTED: '电脑身份校验未通过，请检查中转设置后重试。',
  SECURE_LINK_UNVERIFIED: '加密通道尚未验证，请检查中转服务和电脑网络。',
  SECURE_BACKEND_OFFLINE: '电脑上的助手尚未就绪，请打开助手后重试。',
  SELF_HOSTED_INVALID: '服务器信息有误或与这台电脑不匹配，请核对配对信息、地址和端口。',
  SELF_HOSTED_BUSY: '已有安装正在等待连接，请先完成或等待命令过期。',
  SELF_HOSTED_BOOTSTRAP_FAILED: '配对结果未确认，请查看服务器终端。未安装时可重新运行命令；若服务器已显示安装完成，请用页面中的手动配置方式恢复。',
  SECURE_SERVICE_RUNNING: '已有其他加密连接正在运行，请先停止它，再重试。',
  SECURE_STOP_FAILED: '无法停止旧连接，原设置已保留。请关闭旧连接后重试。',
  SECURE_IP_UPDATE_INVALID: '仅支持同一自建服务器更换 IPv4，服务器身份和端口必须保持不变。',
  SECURE_IP_RECOVERY_REQUIRED: '更新中断，旧配置已保留；需要先恢复旧配置，再重试。',
  SECURE_IP_RECOVERY_INVALID: '不能恢复所选配置，现有数据已保留。请检查连接状态。',
  HOSTED_SERVICE_UNAVAILABLE: '连接服务暂时不可用，请稍后重试。',
  HOSTED_INVITATION_REJECTED: '测试码无效、已过期或已用于其他电脑，请检查后重试。',
  HOSTED_RESPONSE_INVALID: '中转返回的连接信息无法确认，请稍后重试。电脑准备结果已保留。',
  HOSTED_ENROLLMENT_INVALID: '电脑的接入申请需要检查，原设置已保留。',
  HOSTED_SERVICE_INVALID: '项目方中转地址需要检查，原设置已保留。',
  SEARCH_UNAVAILABLE: '搜索包下载地址尚未提供。',
  SEARCH_BUSY: '搜索包正在处理，请稍候。',
  SEARCH_INTEGRITY_FAILED: '搜索包校验未通过，请重试。',
  SEARCH_IN_USE: '智能搜索正在使用。请重启连接器，再删除智能搜索。',
};

export function createDashboardHandler({ actions, getOrigin }) {
  return async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      response.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
    };
    const origin = getOrigin();
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) {
      send(403, { error: '仅允许从本机连接器页面操作。' }); return;
    }
    try {
      if (request.method === 'GET' && assets[request.url]) {
        const [path, type] = assets[request.url]; send(200, readFileSync(new URL(path, import.meta.url)), type); return;
      }
      if (request.method === 'GET' && request.url === '/android-download-qr.png') {
        androidDownloadQr ||= QRCode.toBuffer(androidReleases, { width: 320, margin: 4 });
        send(200, await androidDownloadQr, 'image/png'); return;
      }
      if (request.method === 'GET' && (request.url === '/api/status' || request.url === '/api/status?refresh=1')) { send(200, await actions.status(request.url.endsWith('?refresh=1'))); return; }
      if (request.method === 'GET' && request.url === '/api/enrollment') { send(200, await actions.enrollment()); return; }
      if (request.method === 'GET' && request.url === '/api/self-hosted-progress' && actions.selfHostedProgress) { send(200, await actions.selfHostedProgress()); return; }
      if (request.method === 'GET' && request.url === '/api/search-package' && actions.searchPackageStatus) { send(200, await actions.searchPackageStatus()); return; }
      const action = { '/api/prepare': 'prepare', '/api/invitation': 'invitation', '/api/connect': 'connect', '/api/pair': 'pair',
        '/api/self-hosted-command': 'selfHostedCommand', '/api/self-hosted-pair': 'pairSelfHosted',
        '/api/self-hosted-prepare': 'prepareSelfHosted', '/api/self-hosted-finish': 'finishSelfHosted', '/api/self-hosted-change-ip': 'changeSelfHostedIp', '/api/self-hosted-restore': 'restoreSelfHostedIp',
        '/api/search-install': 'searchPackageInstall', '/api/search-remove': 'searchPackageRemove' }[request.url];
      if (request.method !== 'POST' || !action || typeof actions[action] !== 'function') { send(404, { error: '找不到此页面。' }); return; }
      if (request.headers.origin !== origin || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { send(403, { error: '请从本机连接器页面操作。' }); return; }
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) { send(413, { error: '接入文件过大，请检查后重试。' }); return; } chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { error: '文件内容无法识别，请重新选择。' }); return; }
      send(200, await actions[action](body));
    } catch (error) { send(409, { error: errorMessages[error.code] ?? '操作未完成，现有设置已保留。请检查电脑连接后重试。' }); }
  };
}
