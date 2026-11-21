import { fileURLToPath } from 'node:url';
import { verifyConnectorPackage } from './integrity.mjs';

try {
  console.log('正在检查连接器文件，请稍候…');
  await verifyConnectorPackage(fileURLToPath(new URL('../../', import.meta.url)));
  await import('./connector.mjs');
} catch {
  console.error('连接器文件不完整或已改变，请重新解压完整试用包后再打开。现有设置没有修改。');
  process.exitCode = 1;
}
