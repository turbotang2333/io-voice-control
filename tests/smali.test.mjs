import assert from 'node:assert/strict';
import test from 'node:test';
const load = () => import('../scripts/patch-host.mjs');

test('wrapping preserves the original method body and dispatches to the probe', async () => {
  const { wrapMethod } = await load();
  const input = '.class public final Lp8/c$c;\n.super Ljava/lang/Object;\n.method public final onResponseComplete()V\n    .locals 1\n    const-string v0, "original-marker"\n    return-void\n.end method\n';
  const output = wrapMethod(input, 'onResponseComplete', '()V', 'p0 .. p0', 'dispatchComplete(Ljava/lang/Object;)V', false);
  assert.match(output, /paseoProbeOriginal_onResponseComplete\(\)V\n    \.locals 1\n    const-string v0, "original-marker"\n    return-void\n.end method/);
  assert.match(output, /invoke-static\/range \{p0 \.\. p0\}, Lcn\/yilu\/rayneopaseo\/ProbeAddon;->dispatchComplete\(Ljava\/lang\/Object;\)V/);
});

test('unknown and already modified callback layouts are rejected', async () => {
  const { wrapMethod } = await load();
  assert.throws(() => wrapMethod('.class public LUnknown;\n', 'onResponseComplete', '()V', 'p0 .. p0', 'x', false));
  assert.throws(() => wrapMethod('.class public LUnknown;\n.method public final paseoProbeOriginal_onResponseComplete()V\n.end method\n', 'onResponseComplete', '()V', 'p0 .. p0', 'x', false));
});

test('prompt transport observer preserves the original receiver', async () => {
  const { observePromptTransport } = await load();
  const input = '.class public final LX3/U;\n.method public static i(LX3/C;LX3/p;)V\n    .locals 1\n    return-void\n.end method\n';
  const output = observePromptTransport(input);
  assert.match(output, /paseoProbeOriginal_i\(LX3\/C;LX3\/p;\)V\n    \.locals 1/);
  assert.match(output, /invoke-static \{p1\}, Lcn\/yilu\/rayneopaseo\/ProbeAddon;->observePromptPacket\(Ljava\/lang\/Object;\)V/);
  assert.match(output, /invoke-static \{p0, p1\}, LX3\/U;->paseoProbeOriginal_i\(LX3\/C;LX3\/p;\)V/);
  assert.throws(() => observePromptTransport(output));
});

test('native idle configuration is applied before each assistant workflow initialization', async () => {
  const { configureNativeInputWorkflow } = await load();
  const call = '    invoke-virtual {v0, v2, v4}, Lcom/rayneo/airuntime/controller/AssistantController;->initWorkflow(Lcom/rayneo/airuntime/controller/RayNeoAiConfig;Lcom/rayneo/airuntime/controller/AiResultListener;)Z';
  const input = '.class public final Lp8/c;\n' + call + '\n    move-result v0\n';
  const output = configureNativeInputWorkflow(input);
  assert.match(output, /invoke-static \{v2\}, Lcn\/yilu\/rayneopaseo\/ProbeAddon;->configureNativeInputWorkflow\(Ljava\/lang\/Object;\)V\n\n    invoke-virtual \{v0, v2, v4\}/);
  assert.ok(output.endsWith(call + '\n    move-result v0\n'));
  assert.throws(() => configureNativeInputWorkflow(output));
  assert.throws(() => configureNativeInputWorkflow(input + call));
  assert.throws(() => configureNativeInputWorkflow('unknown'));
});
