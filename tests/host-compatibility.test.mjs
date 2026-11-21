import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import * as patch from '../scripts/patch-host.mjs';

const state = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-host-compatibility');
mkdirSync(state, { recursive: true });
const method = (name, signature, flags = 'public final') => `.method ${flags} ${name}${signature}\n    .locals 0\n    return-void\n.end method\n`;
function fixture(version) {
  const root = mkdtempSync(join(state, 'decoded-'));
  const modern = version === '1.0.10';
  const types = modern ? ['m9/c$c', 'l9/e$b', 'com/rayneo/venus/MainActivity', 'O4/Y', 'm9/c']
    : ['p8/c$c', 'o8/f$b', 'com/rayneo/venus/MainActivity', 'X3/U', 'p8/c'];
  const files = types.map((type, i) => {
    const dex = modern && i !== 3 ? 3 : 2;
    // Apktool resolves case collisions by suffixing directories and filenames.
    const path = join(root, `smali_classes${dex}`, type.replace(/^m9\//, 'm9.1/').replace(/^l9\//, 'l9.1/') + '.smali');
    let text = `.class public final L${type};\n.super Ljava/lang/Object;\n`;
    if (i === 0) text += method('onAsrResult', '(Ljava/lang/String;ZLjava/lang/String;)V')
      + method('onNlpResult', '(Lcom/rayneo/airuntime/controller/NlpResult;)V')
      + method('onResponseComplete', '()V') + method('onAudioRecordStart', '()V') + method('onError', '(ILjava/lang/String;)V');
    if (i === 1) text += method('onAsrResult', '(Ljava/lang/String;Z)V');
    if (i === 2) text += method('onPostResume', '()V');
    if (i === 3) text += method(modern ? 'l' : 'i', modern ? '(LO4/G;LO4/q;)V' : '(LX3/C;LX3/p;)V', 'public static');
    if (i === 4) text += '.method public final init()V\n    .locals 5\n'
      + '    invoke-virtual {v0, v2, v4}, Lcom/rayneo/airuntime/controller/AssistantController;->initWorkflow(Lcom/rayneo/airuntime/controller/RayNeoAiConfig;Lcom/rayneo/airuntime/controller/AiResultListener;)Z\n    return-void\n.end method\n';
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return { path, text };
  });
  return { root, files };
}

for (const version of ['1.0.6', '1.0.10']) test(`${version} patch preserves stock callbacks and moves every hook into the added DEX`, () => {
  const { root, files } = fixture(version);
  assert.equal(typeof patch.patchDecodedHost, 'function');
  patch.patchDecodedHost(root, version);
  for (const { path } of files) assert.equal(existsSync(path), false);
  const owner = version === '1.0.10' ? 'm9/c$c' : 'p8/c$c';
  const callback = readFileSync(join(root, 'smali_classes5', owner + '.smali'), 'utf8');
  assert.match(callback, /paseoProbeOriginal_onAsrResult/);
  assert.match(callback, /ProbeAddon;->dispatchAsr/);
  const transport = readFileSync(join(root, 'smali_classes5', version === '1.0.10' ? 'O4/Y.smali' : 'X3/U.smali'), 'utf8');
  assert.ok(transport.includes(version === '1.0.10'
    ? 'LO4/Y;->paseoProbeOriginal_l(LO4/G;LO4/q;)V' : 'LX3/U;->paseoProbeOriginal_i(LX3/C;LX3/p;)V'));
  assert.match(transport, /ProbeAddon;->observePromptPacket/);
  assert.doesNotMatch(transport, /PromptDisplayTrial;/);
  assert.throws(() => patch.patchDecodedHost(root, version), /already patched/);
});

test('a mismatched callback descriptor stops before changing any decoded file', () => {
  const { root, files } = fixture('1.0.10');
  const wrong = files[0].text.replace('Lm9/c$c;', 'LM9/c$c;');
  writeFileSync(files[0].path, wrong);
  assert.equal(typeof patch.patchDecodedHost, 'function');
  assert.throws(() => patch.patchDecodedHost(root, '1.0.10'), /class|descriptor|layout/i);
  assert.equal(readFileSync(files[0].path, 'utf8'), wrong);
  for (const entry of files.slice(1)) assert.equal(readFileSync(entry.path, 'utf8'), entry.text);
  assert.equal(existsSync(join(root, '.paseo-probe-patched')), false);
});

test('a late signature mismatch leaves earlier hooks untouched', () => {
  const { root, files } = fixture('1.0.10');
  writeFileSync(files[4].path, files[4].text.replace('initWorkflow(', 'renamedWorkflow('));
  assert.equal(typeof patch.patchDecodedHost, 'function');
  assert.throws(() => patch.patchDecodedHost(root, '1.0.10'), /layout/i);
  for (const entry of files.slice(0, 4)) assert.equal(readFileSync(entry.path, 'utf8'), entry.text);
});

test('the paused display experiment cannot enter a 1.0.10 build', () => {
  const { root, files } = fixture('1.0.10');
  assert.equal(typeof patch.patchDecodedHost, 'function');
  assert.throws(() => patch.patchDecodedHost(root, '1.0.10', { promptDisplayTrial: true }), /trial|experiment/i);
  for (const entry of files) assert.equal(readFileSync(entry.path, 'utf8'), entry.text);
});

test('unknown original APKs are rejected without a decoded-tree write', async () => {
  const { root, files } = fixture('1.0.10');
  const input = join(root, 'unknown.apk'); writeFileSync(input, 'untrusted');
  await assert.rejects(patch.patchHost(root, input), /pinned|checksum|unsupported/i);
  for (const entry of files) assert.equal(readFileSync(entry.path, 'utf8'), entry.text);
});

test('1.0.25 hooks are moved to DEX 8 while stock DEX 5 remains untouched', () => {
  const state = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-host-compatibility');
  mkdirSync(state, { recursive: true });
  const root = mkdtempSync(join(state, 'decoded-1025-'));
  const types = ['lm0/d$c', 'km0/e$b', 'com/rayneo/venus/MainActivity', 'com/ffalconxr/mercury/coreconnect/x0', 'lm0/d'];
  const files = types.map((type, i) => {
    const path = join(root, `smali_classes${i === 3 ? 3 : 4}`, type + '.smali');
    let text = `.class public final L${type};\n.super Ljava/lang/Object;\n`;
    if (i === 0) text += method('onAsrResult', '(Ljava/lang/String;ZLjava/lang/String;)V') + method('onNlpResult', '(Lcom/rayneo/airuntime/controller/NlpResult;)V') + method('onResponseComplete', '()V') + method('onAudioRecordStart', '()V') + method('onError', '(ILjava/lang/String;)V');
    if (i === 1) text += method('onAsrResult', '(Ljava/lang/String;Z)V');
    if (i === 2) text += method('onPostResume', '()V');
    if (i === 3) text += method('l', '(Lcom/ffalconxr/mercury/coreconnect/f0;Lcom/ffalconxr/mercury/coreconnect/p;)V', 'public static');
    if (i === 4) text += '.method public final init()V\n    .locals 5\n    invoke-virtual {v0, v2, v4}, Lcom/rayneo/airuntime/controller/AssistantController;->initWorkflow(Lcom/rayneo/airuntime/controller/RayNeoAiConfig;Lcom/rayneo/airuntime/controller/AiResultListener;)Z\n    return-void\n.end method\n';
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path;
  });
  const untouched = join(root, 'smali_classes5', 'stock.smali'); mkdirSync(dirname(untouched), { recursive: true }); writeFileSync(untouched, 'stock');
  patch.patchDecodedHost(root, '1.0.25');
  for (const path of files) assert.equal(existsSync(path), false);
  assert.equal(readFileSync(untouched, 'utf8'), 'stock');
  assert.match(readFileSync(join(root, 'smali_classes8', 'lm0', 'd$c.smali'), 'utf8'), /ProbeAddon;->dispatchAsr/);
});

test('1.0.25 runtime bindings use its renamed host methods', async () => {
  const { hostProfile, renderHostBindings } = await import('../scripts/host-profile.mjs');
  const bindings = renderHostBindings(hostProfile('1.0.25'));
  assert.match(bindings, /ASSISTANT_EXIT_METHOD = "v"/);
  assert.match(bindings, /TRANSPORT_SEND_METHOD = "u"/);
});
