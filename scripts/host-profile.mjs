import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const profiles = JSON.parse(readFileSync(new URL('./host-profiles.json', import.meta.url), 'utf8'));
export function hostProfile(versionName) {
  const profile = profiles.find(entry => entry.versionName === versionName);
  if (!profile) throw new Error('Unsupported pinned host version');
  return structuredClone(profile);
}
export async function identifyHost(apk) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(apk)) hash.update(chunk);
  const digest = hash.digest('hex');
  const profile = profiles.find(entry => entry.sha256 === digest);
  if (!profile) throw new Error('Unsupported APK checksum; only pinned original APKs are accepted');
  return structuredClone(profile);
}
export function renderHostBindings(profile) {
  const names = { callbackClass: 'CALLBACK_CLASS', asrRecorder: 'ASR_RECORDER', microphone: 'MICROPHONE',
    audioBytesMethod: 'AUDIO_BYTES_METHOD', transport: 'TRANSPORT', devicesMethod: 'DEVICES_METHOD', request: 'REQUEST', business: 'BUSINESS',
    assistantExitMethod: 'ASSISTANT_EXIT_METHOD', transportSendMethod: 'TRANSPORT_SEND_METHOD' };
  return 'package cn.yilu.rayneopaseo;\n\n// Generated from the fingerprint-verified host profile.\nfinal class HostBindings {\n'
    + Object.entries(names).map(([key, name]) => `    static final String ${name} = ${JSON.stringify(profile.runtime[key] ?? ({ assistantExitMethod: 's', transportSendMethod: 't' })[key])};\n`).join('')
    + '    static void checkSource(Object source) {\n'
    + '        if (source == null || !CALLBACK_CLASS.equals(source.getClass().getName()))\n'
    + '            throw new IllegalStateException("Unsupported host callback");\n    }\n}\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--java-output')) throw new Error('Invalid host profile arguments');
  const profile = await identifyHost(args[0]);
  if (args.length === 3) {
    mkdirSync(dirname(args[2]), { recursive: true }); writeFileSync(args[2], renderHostBindings(profile));
  }
  console.log(JSON.stringify(profile));
}
