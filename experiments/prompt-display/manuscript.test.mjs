import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('manuscript transfer honors UTF-8 byte ranges, task ownership and verified completion', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-manuscript-transfer');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/ManuscriptTransfer.java',
    'experiments/prompt-display/ManuscriptTransferTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ManuscriptTransferTest'], { encoding: 'utf8' });
  assert.match(result, /\d+ manuscript transfer checks passed/);
});

test('native file callbacks keep the stock behavior and add trial observations once', async () => {
  const { observeManuscriptFileTransfers } = await import('../../scripts/patch-host.mjs');
  assert.equal(typeof observeManuscriptFileTransfers, 'function');
  const stock = '.class public LX3/u;\n'
    + '.method public final q(Ljava/lang/String;LX3/C;Li4/S;Ljava/lang/String;Ljava/lang/String;)V\n    .locals 0\n    return-void\n.end method\n'
    + '.method public final m(Ljava/lang/String;LX3/C;Li4/S;Li4/G;)V\n    .locals 0\n    return-void\n.end method\n';
  const withSend = stock + '.method public final t(LX3/Q;Lkotlin/jvm/functions/Function2;)V\n    .locals 0\n    return-void\n.end method\n';
  const output = observeManuscriptFileTransfers(withSend);
  assert.match(output, /invoke-virtual\/range \{p0 \.\. p5\}, LX3\/u;->paseoProbeOriginal_q/);
  assert.match(output, /invoke-virtual\/range \{p0 \.\. p4\}, LX3\/u;->paseoProbeOriginal_m/);
  assert.match(output, /PromptDisplayTrial;->observeFileShareSuccess/);
  assert.match(output, /PromptDisplayTrial;->observeFileShareFailure/);
  assert.match(output, /invoke-virtual\/range \{p0 \.\. p2\}, LX3\/u;->paseoProbeOriginal_t/);
  assert.match(output, /PromptDisplayTrial;->observeManuscriptSend/);
  assert.throws(() => observeManuscriptFileTransfers(output));
  assert.throws(() => observeManuscriptFileTransfers('unrecognized SDK layout'));
});

test('a confirmed manuscript pauses after startup and stays open without an optional display ACK', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-manuscript-read');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/ManuscriptReadGate.java',
    'experiments/prompt-display/ManuscriptReadGateTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ManuscriptReadGateTest'], { encoding: 'utf8' });
  assert.match(result, /29 manuscript read lifecycle checks passed/);
});

test('reply reading is one shot, ignores local controls and cancels stale or oversized transfers', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-reply-reading');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'android-addon/src/cn/yilu/rayneopaseo/VoiceCommand.java',
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/ReplyReadingGate.java',
    'experiments/prompt-display/ReplyReadingGateTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ReplyReadingGateTest'], { encoding: 'utf8' });
  assert.match(result, /\d+ reply reading gate checks passed/);
});

test('manuscript transfer waits for prepare success and ignores duplicate or non-success replies', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-manuscript-prepare');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/ManuscriptPrepareGate.java',
    'experiments/prompt-display/ManuscriptPrepareGateTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ManuscriptPrepareGateTest'], { encoding: 'utf8' });
  assert.match(result, /8 manuscript prepare ordering checks passed/);
});

test('only an owned manuscript completion can bypass the stock handler, with bounded duplicate replies', () => {
  const out = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-manuscript-completion');
  mkdirSync(out, { recursive: true });
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
    'experiments/prompt-display/src/cn/yilu/rayneopaseo/ManuscriptCompletionGate.java',
    'experiments/prompt-display/ManuscriptCompletionGateTest.java'], { stdio: 'pipe' });
  const result = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.ManuscriptCompletionGateTest'], { encoding: 'utf8' });
  assert.match(result, /17 manuscript completion ownership checks passed/);
});
