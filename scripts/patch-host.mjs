import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostProfile, identifyHost } from './host-profile.mjs';

export function wrapMethod(text, name, signature, registers, dispatcher, callOriginal, dispatcherClass = 'ProbeAddon', originalRegisters = registers) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(dispatcherClass)) throw new Error('Invalid dispatcher class');
  const header = `.method public final ${name}${signature}`;
  const original = `paseoProbeOriginal_${name}`;
  const className = text.match(/^\.class[^\n]* (L[^;]+;)\r?$/m)?.[1];
  if (!className || text.includes(original) || text.split(header).length !== 2) throw new Error('Unsupported callback layout');
  const replacement = text.replace(header, `.method public final ${original}${signature}`);
  return replacement + `\n${header}\n    .locals 0\n` +
    (callOriginal ? `    invoke-virtual/range {${originalRegisters}}, ${className}->${original}${signature}\n` : '') +
    `    invoke-static/range {${registers}}, Lcn/yilu/rayneopaseo/${dispatcherClass};->${dispatcher}\n    return-void\n.end method\n`;
}

export function observeManuscriptFileTransfers(text) {
  const success = wrapMethod(text, 'q', '(Ljava/lang/String;LX3/C;Li4/S;Ljava/lang/String;Ljava/lang/String;)V',
    'p0 .. p5', 'observeFileShareSuccess(Ljava/lang/Object;Ljava/lang/String;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/String;Ljava/lang/String;)V', true, 'PromptDisplayTrial');
  const failure = wrapMethod(success, 'm', '(Ljava/lang/String;LX3/C;Li4/S;Li4/G;)V', 'p0 .. p4',
    'observeFileShareFailure(Ljava/lang/Object;Ljava/lang/String;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)V', true, 'PromptDisplayTrial');
  return wrapMethod(failure, 't', '(LX3/Q;Lkotlin/jvm/functions/Function2;)V', 'p0 .. p2',
    'observeManuscriptSend(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)V', true, 'PromptDisplayTrial');
}

export function observePromptTransport(text, { promptDisplayTrial = false, profile = hostProfile('1.0.6') } = {}) {
  const signature = `(${profile.device}${profile.packet})V`;
  const header = `.method public static ${profile.transportMethod}${signature}`;
  const original = `paseoProbeOriginal_${profile.transportMethod}`;
  if (text.includes(original) || text.split(header).length !== 2) throw new Error('Unsupported prompt transport layout');
  return text.replace(header, `.method public static ${original}${signature}`) +
    `\n${header}\n    .locals ${promptDisplayTrial ? 1 : 0}\n` +
    '    invoke-static {p1}, Lcn/yilu/rayneopaseo/ProbeAddon;->observePromptPacket(Ljava/lang/Object;)V\n' +
    (promptDisplayTrial ? '    invoke-static {p1}, Lcn/yilu/rayneopaseo/PromptDisplayTrial;->observePacket(Ljava/lang/Object;)V\n' : '') +
    (promptDisplayTrial ? '    invoke-static {p0, p1}, Lcn/yilu/rayneopaseo/PromptDisplayTrial;->consumePacket(Ljava/lang/Object;Ljava/lang/Object;)Z\n'
      + '    move-result v0\n    if-eqz v0, :paseo_dispatch_original\n    return-void\n    :paseo_dispatch_original\n' : '') +
    `    invoke-static {p0, p1}, ${profile.transport}->${original}${signature}\n` +
    '    return-void\n.end method\n';
}

export function observeTeleprompterAudioEvents(text, { promptDisplayTrial = false } = {}) {
  if (!promptDisplayTrial) return text;
  let observed = wrapMethod(text, 'onAudioRecordStart', '()V', 'p0 .. p0',
    'observeTeleprompterAudioStart(Ljava/lang/Object;)V', true, 'PromptDisplayTrial');
  observed = wrapMethod(observed, 'onAudioRecordEnd', '()V', 'p0 .. p0',
    'observeTeleprompterAudioEnd(Ljava/lang/Object;)V', true, 'PromptDisplayTrial');
  observed = wrapMethod(observed, 'onStartResult', '(ZLjava/lang/String;)V', 'p0 .. p1',
    'observeTeleprompterAsrStartResult(Ljava/lang/Object;Z)V', true, 'PromptDisplayTrial', 'p0 .. p2');
  observed = wrapMethod(observed, 'onError', '(ILjava/lang/String;)V', 'p0 .. p1',
    'observeTeleprompterAsrError(Ljava/lang/Object;I)V', true, 'PromptDisplayTrial', 'p0 .. p2');
  return wrapMethod(observed, 'onVadStatusChange', '(I)V', 'p0 .. p1',
    'observeTeleprompterVadStatus(Ljava/lang/Object;I)V', true, 'PromptDisplayTrial');
}

export function observeAssistantPluginAttachment(text) {
  return wrapMethod(text, 'onAttachedToEngine', '(Lja/b;)V', 'p0 .. p0',
    'observeNativeAssistantPlugin(Ljava/lang/Object;)V', true, 'PromptDisplayTrial', 'p0 .. p1');
}

export function configureNativeInputWorkflow(text) {
  const call = '    invoke-virtual {v0, v2, v4}, Lcom/rayneo/airuntime/controller/AssistantController;->initWorkflow(Lcom/rayneo/airuntime/controller/RayNeoAiConfig;Lcom/rayneo/airuntime/controller/AiResultListener;)Z';
  if (text.includes('ProbeAddon;->configureNativeInputWorkflow') || text.split(call).length !== 2) throw new Error('Unsupported assistant initialization layout');
  return text.replace(call, '    invoke-static {v2}, Lcn/yilu/rayneopaseo/ProbeAddon;->configureNativeInputWorkflow(Ljava/lang/Object;)V\n\n' + call);
}

export function installPromptDisplayTrial(entry) {
  const call = '    invoke-static/range {p0 .. p0}, Lcn/yilu/rayneopaseo/ProbeAddon;->install(Landroid/app/Activity;)V\n';
  if (entry.includes('PromptDisplayTrial;') || entry.split(call).length !== 2) throw new Error('Unsupported trial entry layout');
  return entry.replace(call, call + '    invoke-static/range {p0 .. p0}, Lcn/yilu/rayneopaseo/PromptDisplayTrial;->install(Landroid/app/Activity;)V\n');
}

// Resolve by the .class descriptor, not Windows' case-insensitive filename.
export function locateHostClass(host, dex, descriptor) {
  const relative = descriptor.slice(1, -1);
  let directories = [join(host, dex)];
  for (const part of posix.dirname(relative).split('/')) {
    directories = directories.flatMap(directory => readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && (entry.name.toLowerCase() === part.toLowerCase()
        || new RegExp(`^${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`, 'i').test(entry.name)))
      .map(entry => join(directory, entry.name)));
  }
  const basename = posix.basename(relative);
  const filenames = new RegExp(`^${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.\\d+)?\\.smali$`, 'i');
  const matches = directories.flatMap(directory => readdirSync(directory).filter(name => filenames.test(name))
    .map(name => join(directory, name))).filter(path => readFileSync(path, 'utf8').match(/^\.class[^\n]* (L[^;]+;)\r?$/m)?.[1] === descriptor);
  if (matches.length !== 1) throw new Error(`Unsupported class descriptor layout: ${descriptor}`);
  return matches[0];
}

export async function patchHost(host, apk, options = {}) {
  const profile = await identifyHost(apk);
  return patchDecodedHost(host, profile.versionName, options);
}

export function patchDecodedHost(host, versionName, { promptDisplayTrial = false } = {}) {
  const profile = hostProfile(versionName);
  if (promptDisplayTrial && versionName !== '1.0.6') throw new Error('Display trial is only supported on the pinned 1.0.6 host');
  const marker = join(host, '.paseo-probe-patched');
  if (existsSync(marker)) throw new Error('Host already patched; use a fresh decoded input');
  const listener = locateHostClass(host, profile.callbackDex, profile.callback);
  const teleprompter = locateHostClass(host, profile.callbackDex, profile.teleprompter);
  const activityDescriptor = 'Lcom/rayneo/venus/MainActivity;';
  const activity = locateHostClass(host, profile.callbackDex, activityDescriptor);
  const transport = locateHostClass(host, profile.transportDex, profile.transport);
  const assistant = locateHostClass(host, profile.callbackDex, profile.assistant);
  const assistantPlugin = promptDisplayTrial
    ? locateHostClass(host, profile.callbackDex, 'Lcom/rayneo/rayneo_venus_sdk_plugin/f;') : null;
  let voice = readFileSync(listener, 'utf8');
  voice = wrapMethod(voice, 'onAsrResult', '(Ljava/lang/String;ZLjava/lang/String;)V', 'p0 .. p3', 'dispatchAsr(Ljava/lang/Object;Ljava/lang/String;ZLjava/lang/String;)V', false);
  voice = wrapMethod(voice, 'onNlpResult', '(Lcom/rayneo/airuntime/controller/NlpResult;)V', 'p0 .. p1', 'dispatchNlp(Ljava/lang/Object;Ljava/lang/Object;)V', false);
  voice = wrapMethod(voice, 'onResponseComplete', '()V', 'p0 .. p0', 'dispatchComplete(Ljava/lang/Object;)V', false);
  voice = wrapMethod(voice, 'onAudioRecordStart', '()V', 'p0 .. p0', 'observeNativeAudioStart(Ljava/lang/Object;)V', true);
  voice = wrapMethod(voice, 'onError', '(ILjava/lang/String;)V', 'p0 .. p2', 'observeNativeError(Ljava/lang/Object;ILjava/lang/String;)V', true);
  let entry = wrapMethod(readFileSync(activity, 'utf8'), 'onPostResume', '()V', 'p0 .. p0', 'install(Landroid/app/Activity;)V', true);
  if (promptDisplayTrial) entry = installPromptDisplayTrial(entry);
  let teleprompterEntry = wrapMethod(readFileSync(teleprompter, 'utf8'), 'onAsrResult', '(Ljava/lang/String;Z)V', 'p0 .. p2', 'observeTeleprompterAsr(Ljava/lang/Object;Ljava/lang/String;Z)V', true,
    promptDisplayTrial ? 'PromptDisplayTrial' : 'ProbeAddon');
  if (promptDisplayTrial) teleprompterEntry = observeTeleprompterAudioEvents(teleprompterEntry, { promptDisplayTrial });
  const promptTransportEntry = observePromptTransport(readFileSync(transport, 'utf8'), { promptDisplayTrial, profile });
  const assistantEntry = configureNativeInputWorkflow(readFileSync(assistant, 'utf8'));
  const assistantPluginEntry = promptDisplayTrial
    ? observeAssistantPluginAttachment(readFileSync(assistantPlugin, 'utf8')) : null;
  const destinations = [
    [listener, profile.callback, voice],
    [activity, activityDescriptor, entry],
    [teleprompter, profile.teleprompter, teleprompterEntry],
    [transport, profile.transport, promptTransportEntry],
    [assistant, profile.assistant, assistantEntry],
  ];
  if (promptDisplayTrial) {
    destinations.push([assistantPlugin, 'Lcom/rayneo/rayneo_venus_sdk_plugin/f;', assistantPluginEntry]);
    const nativeTransfer = locateHostClass(host, profile.transportDex, 'LX3/u;');
    destinations.push([nativeTransfer, 'LX3/u;',
      observeManuscriptFileTransfers(readFileSync(nativeTransfer, 'utf8'))]);
  }
  // All signatures and the original APK are checked before the first write.
  const usedTargets = new Set();
  const writes = destinations.map(([source, descriptor, content]) => {
    const hookNumber = /^classes([1-9][0-9]*)\.dex$/.exec(profile.hookDex)?.[1];
    if (!hookNumber || Number(hookNumber) < 2) throw new Error('Invalid hook DEX');
    const base = join(host, `smali_classes${hookNumber}`, descriptor.slice(1, -1));
    let target = base + '.smali', suffix = 0;
    while (usedTargets.has(target.toLowerCase())) target = `${base}.${++suffix}.smali`;
    usedTargets.add(target.toLowerCase());
    return [source, target, content];
  });
  for (const [, target] of writes) {
    if (!resolve(target).startsWith(resolve(host) + '\\') && !resolve(target).startsWith(resolve(host) + '/')) throw new Error('Invalid host path');
    if (existsSync(target)) throw new Error('Hook destination already exists; use a fresh decoded input');
  }
  for (const [source, target, content] of writes) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target); writeFileSync(target, content);
  }
  writeFileSync(marker, JSON.stringify({ versionName, sha256: profile.sha256, promptDisplayTrial }) + '\n');
  if (promptDisplayTrial) writeFileSync(join(host, '.paseo-prompt-display-trial'), 'Display experiments with one-shot completed-reply handoff; no automatic prompts.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = process.argv.slice(4);
  if (flags.some(flag => flag !== '--prompt-display-trial')) throw new Error('Unknown patch option');
  await patchHost(process.argv[2], process.argv[3], { promptDisplayTrial: flags.includes('--prompt-display-trial') });
  console.log('Validated original APK; patched native callbacks, transport observer and trial-only idle configuration without OTA hooks.');
}
