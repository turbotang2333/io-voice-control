import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { hostProfile, renderHostBindings } from '../scripts/host-profile.mjs';

// The complete reflection boundary is exercised: controller init, audio feed,
// callback delivery, microphone start/stop and task release. Only the SDK is fake.
for (const [version, callback, recorder, microphone, bytesMethod] of [
  ['1.0.6', 'p8.c$c', 'o8.p', 'l8.V0', 'u'],
  ['1.0.10', 'm9.c$c', 'l9.p', 'i9.W0', 't'],
  ['1.0.25', 'lm0.d$c', 'km0.o', 'com.rayneo.rayneo_venus_sdk_plugin.f3', 'W'],
]) test(`${version} native background input receives audio and releases its SDK task`, () => {
  const state = join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-host-compatibility');
  mkdirSync(state, { recursive: true });
  const out = mkdtempSync(join(state, 'asr-')), sources = [];
  function source(name, text) {
    const path = join(out, name.replaceAll('.', '/') + '.java');
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); sources.push(path);
  }
  const declare = (name, body, extra = '') => {
    const dot = name.lastIndexOf('.');
    source(name, `package ${name.slice(0, dot)}; public class ${name.slice(dot + 1)} ${extra} { ${body} }`);
  };
  source('cn.yilu.rayneopaseo.HostBindings', renderHostBindings(hostProfile(version)));
  declare('android.content.Context', 'public ClassLoader getClassLoader() { return getClass().getClassLoader(); }');
  declare(callback, 'public cn.yilu.rayneopaseo.AsrFixture.Owner a = new cn.yilu.rayneopaseo.AsrFixture.Owner();');
  declare(recorder, '', 'extends com.rayneo.airuntime.bridge.AudioRecorderBridge.AudioRecorderAdapter');
  const micName = microphone.split('.').at(-1);
  declare(microphone, `public static final ${micName} a = new ${micName}();
    public void a(String reason, boolean start) { cn.yilu.rayneopaseo.AsrFixture.microphone(reason, start); }`);
  declare('com.rayneo.airuntime.bridge.AudioRecorderBridge', `public static class AudioRecorderAdapter {
    public void notifyRecordData(byte[] bytes) { if(bytes.length != 3 || bytes[2] != 7) throw new AssertionError();
      cn.yilu.rayneopaseo.AsrFixture.feeds++; }
  }`);
  source('com.rayneo.airuntime.controller.ASRResultListener', `package com.rayneo.airuntime.controller;
    public interface ASRResultListener { void onAsrResult(String text, boolean finished); void onError(int code); void onStartResult(boolean ok, String message); }`);
  declare('com.rayneo.airuntime.controller.RayNeoServerConfig', '');
  declare('com.rayneo.airuntime.controller.RayNeoASRConfig', `
    public String format, biz; public int rate, values;
    public void setServerConfig(RayNeoServerConfig v) { if(v == null) throw new AssertionError(); values++; }
    public void setUserName(String v) { if(!v.equals("fixture")) throw new AssertionError(); values++; }
    public void setDeviceName(String v) { if(!v.equals("fixture")) throw new AssertionError(); values++; }
    public void setDeviceModel(String v) { if(!v.equals("fixture")) throw new AssertionError(); values++; }
    public void setLanguageCode(String v) { if(!v.equals("fixture")) throw new AssertionError(); values++; }
    public void setInputAudioFormat(String v) { format=v; }
    public void setInputAudioRate(int v) { rate=v; }
    public void setBizType(String v) { biz=v; }`);
  source('cn.yilu.rayneopaseo.AsrFixture', `package cn.yilu.rayneopaseo;
    import com.rayneo.airuntime.controller.*;
    import com.rayneo.airuntime.bridge.AudioRecorderBridge.AudioRecorderAdapter;
    public class AsrFixture {
      public static int feeds, started, stopped, released, destroyed, initialized, results, micStarts, micStops;
      public static class AgentConfig { public String getInputAudioFormat() { return "opus"; } }
      public static class Config {
        public AgentConfig getAiAgentConfig() { return new AgentConfig(); }
        public RayNeoServerConfig getServerConfig() { return new RayNeoServerConfig(); }
        public String getUserName() { return "fixture"; } public String getDeviceName() { return "fixture"; }
        public String getDeviceModel() { return "fixture"; } public String getLanguageCode() { return "fixture"; }
      }
      public static class Owner { public Config G = new Config(); public Holder d = new Holder(); }
      public static class Holder { public Manager b = new Manager(); }
      public static class Manager { public boolean j;
        public boolean c() { initialized++; j=true; return true; } public Controller b() { return new Controller(); } }
      public static class Controller {
        public Task createTask(String name) { if(!name.equals("paseo_native_input_42")) throw new AssertionError(); return new Task(); }
        public void destroyTask(String name) { if(!name.equals("paseo_native_input_42")) throw new AssertionError(); destroyed++; }
      }
      public static class Task {
        ASRResultListener listener;
        public boolean initTask(RayNeoASRConfig config, AudioRecorderAdapter adapter, ASRResultListener callback) {
          if(config.values != 5 || !"opus".equals(config.format) || config.rate != 16000 || !"TELEPROMPTER".equals(config.biz)) throw new AssertionError();
          if(!adapter.getClass().getName().equals("${recorder}")) throw new AssertionError(); listener=callback; return true;
        }
        public boolean startTask() { started++; listener.onStartResult(true, ""); listener.onAsrResult("segment", true); return true; }
        public void stopTask() { stopped++; } public void releaseTask() { released++; }
      }
      public static class Message { public Data getData() { return new Data(); } }
      public static class Data { public byte[] ${bytesMethod}() { return new byte[]{1, 2, 7}; } }
      public static void microphone(String reason, boolean start) {
        if(start) { if(!reason.equals("paseo_background_input")) throw new AssertionError(); micStarts++; }
        else { if(!reason.equals("paseo_background_input_stop")) throw new AssertionError(); micStops++; }
      }
      public static void main(String[] args) throws Exception {
        NativeBackgroundAsr input = new NativeBackgroundAsr();
        input.start(new android.content.Context(), Class.forName("${callback}").getConstructor().newInstance(), 42,
          new NativeBackgroundAsr.Listener() {
            public void result(String text, boolean done) { if(!text.equals("segment") || !done) throw new AssertionError(); results++; }
            public void error(int code) { throw new AssertionError("unexpected SDK error"); }
          });
        input.offer(new Message()); input.stop(); input.stop(); input.offer(new Message());
        if(started != 1 || initialized != 1 || feeds != 1 || results != 1 || stopped != 1 || released != 1 || destroyed != 1 || micStarts != 1 || micStops != 1)
          throw new AssertionError("lifecycle or audio feed mismatch");
        try { input.start(new android.content.Context(), new Object(), 43, null); throw new AssertionError("unknown callback accepted"); }
        catch (Exception expected) { if(micStarts != 1) throw new AssertionError(); }
        System.out.println("native host lifecycle checks passed");
      }
    }`);
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', out, ...sources,
    'android-addon/src/cn/yilu/rayneopaseo/NativeBackgroundAsr.java'], { stdio: 'pipe' });
  const output = execFileSync('java', ['-cp', out, 'cn.yilu.rayneopaseo.AsrFixture'], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(output, /native host lifecycle checks passed/);
});
