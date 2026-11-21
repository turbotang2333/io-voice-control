import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installPromptDisplayTrial, observeAssistantPluginAttachment, observePromptTransport, wrapMethod } from '../../scripts/patch-host.mjs';
import * as patchHost from '../../scripts/patch-host.mjs';

test('display probe isolates acknowledgements, stale sessions, audio observations and exit', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-prompt-display');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/PromptDisplayTrialState.java',
    'experiments/prompt-display/PromptDisplayTrialStateTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.PromptDisplayTrialStateTest'], { encoding: 'utf8' });
  assert.match(result, /\d+ prompt display lifecycle checks passed/);
});

test('display probe entry is opt in and preserves the existing integration', () => {
  const stock = '.class public LMain;\n.method public final onPostResume()V\n    .locals 0\n    return-void\n.end method\n';
  const standard = wrapMethod(stock, 'onPostResume', '()V', 'p0 .. p0', 'install(Landroid/app/Activity;)V', true);
  assert.doesNotMatch(standard, /PromptDisplayTrial;/);
  const trial = installPromptDisplayTrial(standard);
  assert.ok(trial.indexOf('ProbeAddon;->install') < trial.indexOf('PromptDisplayTrial;->install'));
  assert.throws(() => installPromptDisplayTrial(trial));
  assert.throws(() => installPromptDisplayTrial('unrecognized layout'));
  assert.throws(() => installPromptDisplayTrial(standard + standard));
});

test('display probe transport is absent by default and does not replace the stock receiver', () => {
  const stock = '.class public LX3/U;\n.method public static i(LX3/C;LX3/p;)V\n    .locals 0\n    return-void\n.end method\n';
  const standard = observePromptTransport(stock);
  assert.doesNotMatch(standard, /PromptDisplayTrial;/);
  const trial = observePromptTransport(stock, { promptDisplayTrial: true });
  assert.match(trial, /PromptDisplayTrial;->observePacket\(Ljava\/lang\/Object;\)V/);
  assert.match(trial, /PromptDisplayTrial;->consumePacket\(Ljava\/lang\/Object;Ljava\/lang\/Object;\)Z/);
  assert.match(trial, /if-eqz v0, :paseo_dispatch_original/);
  assert.match(trial, /LX3\/U;->paseoProbeOriginal_i\(LX3\/C;LX3\/p;\)V/);
  assert.throws(() => observePromptTransport(trial, { promptDisplayTrial: true }));
});

test('reader-only ASR observation is wired only in the opt-in display trial', () => {
  const stock = '.class public Lo8/f$b;\n.method public final onAsrResult(Ljava/lang/String;Z)V\n    .locals 0\n    return-void\n.end method\n';
  const standard = wrapMethod(stock, 'onAsrResult', '(Ljava/lang/String;Z)V', 'p0 .. p2',
    'observeTeleprompterAsr(Ljava/lang/Object;Ljava/lang/String;Z)V', true);
  const trial = wrapMethod(stock, 'onAsrResult', '(Ljava/lang/String;Z)V', 'p0 .. p2',
    'observeTeleprompterAsr(Ljava/lang/Object;Ljava/lang/String;Z)V', true, 'PromptDisplayTrial');
  assert.match(standard, /Lcn\/yilu\/rayneopaseo\/ProbeAddon;->observeTeleprompterAsr/);
  assert.match(trial, /Lcn\/yilu\/rayneopaseo\/PromptDisplayTrial;->observeTeleprompterAsr/);
  assert.match(trial, /paseoProbeOriginal_onAsrResult/);
  const observer = readFileSync('experiments/prompt-display/src/cn/yilu/rayneopaseo/PromptDisplayTrial.java', 'utf8');
  assert.match(observer, /observeTeleprompterAsr\(Object source, String text, boolean finished\) \{\s*ManuscriptDisplayTrial\.observeTeleprompterAsr\(text, finished\);\s*\}/);
  assert.doesNotMatch(observer, /ProbeAddon\.observeTeleprompterAsr/);
});

test('wake phrase matcher recognizes only the normalized exact wake phrase', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-prompt-wake');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/WakePhraseMatcher.java',
    'experiments/prompt-display/WakePhraseMatcherTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.WakePhraseMatcherTest'], { encoding: 'utf8' });
  assert.match(result, /wake phrase checks passed/);
});

test('native voice assistant plugin can be observed after its existing registration completes', async () => {
  const stock = '.class public final Lcom/rayneo/rayneo_venus_sdk_plugin/f;\n'
    + '.method public final onAttachedToEngine(Lja/b;)V\n    .locals 0\n    return-void\n.end method\n';
  const trial = observeAssistantPluginAttachment(stock);
  assert.match(trial, /invoke-virtual\/range \{p0 \.\. p1\}, Lcom\/rayneo\/rayneo_venus_sdk_plugin\/f;->paseoProbeOriginal_onAttachedToEngine\(Lja\/b;\)V/);
  assert.match(trial, /PromptDisplayTrial;->observeNativeAssistantPlugin\(Ljava\/lang\/Object;\)V/);
  assert.throws(() => observeAssistantPluginAttachment(trial));
  const observer = readFileSync('experiments/prompt-display/src/cn/yilu/rayneopaseo/ManuscriptDisplayTrial.java', 'utf8');
  assert.match(observer, /finished && session\.wakeToAssistant && WakePhraseMatcher\.matches\(text\)/);
  assert.match(observer, /awaitReaderStop\(session\.device, session\.did\)/);
  assert.doesNotMatch(observer, /startNativeAssistantFromWake\(\), 1200\)/);
  const bridge = readFileSync('experiments/prompt-display/src/cn/yilu/rayneopaseo/PromptDisplayTrial.java', 'utf8');
  assert.doesNotMatch(bridge, /"voice_assistant_trigger_wake"/);
  assert.match(bridge, /expectedDevice\.equals\(connectedDevice\(\)\)/);
  assert.match(bridge, /getField\("e"\)\.getBoolean\(null\)/);
  assert.match(bridge, /getMethod\("k", senderType, int\.class, String\.class\)/);
  assert.match(bridge, /invoke\(null, sender, 9, new JSONObject\(\)\.put\("rc", 1\)/);
  assert.match(bridge, /stage = "queue_glass_app_start"/);
  assert.match(bridge, /stage=" \+ stage \+ " reason="/);
  assert.match(bridge, /cause=" \+ cause\.getClass\(\)\.getSimpleName\(\)/);
  assert.doesNotMatch(bridge, /getMethod\("r", wakeMode\)/);
});

test('teleprompter audio diagnostics are opt in and never pass ASR transcript text', () => {
  const stock = `.class public Lo8/f$b;
.method public final onAudioRecordStart()V
    .locals 0
    return-void
.end method
.method public final onAudioRecordEnd()V
    .locals 0
    return-void
.end method
.method public final onStartResult(ZLjava/lang/String;)V
    .locals 0
    return-void
.end method
.method public final onError(ILjava/lang/String;)V
    .locals 0
    return-void
.end method
.method public final onVadStatusChange(I)V
    .locals 0
    return-void
.end method
`;
  assert.equal(typeof patchHost.observeTeleprompterAudioEvents, 'function');
  assert.equal(patchHost.observeTeleprompterAudioEvents(stock), stock);
  const trial = patchHost.observeTeleprompterAudioEvents(stock, { promptDisplayTrial: true });
  assert.match(trial, /PromptDisplayTrial;->observeTeleprompterAudioStart\(Ljava\/lang\/Object;\)V/);
  assert.match(trial, /invoke-static\/range \{p0 \.\. p1\}, Lcn\/yilu\/rayneopaseo\/PromptDisplayTrial;->observeTeleprompterAsrStartResult/);
  assert.match(trial, /invoke-virtual\/range \{p0 \.\. p2\}, Lo8\/f\$b;->paseoProbeOriginal_onStartResult\(ZLjava\/lang\/String;\)V/);
  assert.match(trial, /invoke-virtual\/range \{p0 \.\. p2\}, Lo8\/f\$b;->paseoProbeOriginal_onError\(ILjava\/lang\/String;\)V/);
  assert.doesNotMatch(trial, /PromptDisplayTrial;->.*\(Ljava\/lang\/Object;Ljava\/lang\/String;Z\)V/);
  assert.equal((trial.match(/\.method public final paseoProbeOriginal_/g) || []).length, 5);
});
