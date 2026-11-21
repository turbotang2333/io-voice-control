package cn.yilu.rayneopaseo;

import android.content.Context;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/** Disposable probe: ASR task fed by native assistant audio; opens no glasses page. */
final class NativeBackgroundAsr {
    interface Listener {
        void result(String text, boolean finished);
        void error(int code);
    }
    private Object controller, task;
    private volatile Object adapter;
    private Method feed;
    private String taskName;
    private Object nativeRecorder;

    private static Object field(Object owner, String name) throws Exception {
        return owner.getClass().getField(name).get(owner);
    }
    private static Object get(Object owner, String name) throws Exception {
        return owner.getClass().getMethod("get" + name).invoke(owner);
    }
    private static void set(Object target, String name, Class<?> type, Object value) throws Exception {
        target.getClass().getMethod("set" + name, type).invoke(target, value);
    }
    synchronized void start(Context context, Object source, long epoch, Listener listener) throws Exception {
        HostBindings.checkSource(source);
        ClassLoader loader = context.getClassLoader();
        Object owner = field(source, "a");
        Object assistantConfig = field(owner, "G");
        Object agentConfig = get(assistantConfig, "AiAgentConfig");
        if (!"opus".equals(get(agentConfig, "InputAudioFormat"))) throw new IllegalStateException("unsupported native audio format");
        Object manager = field(field(owner, "d"), "b");
        if (!manager.getClass().getField("j").getBoolean(manager)
            && !Boolean.TRUE.equals(manager.getClass().getMethod("c").invoke(manager))) {
            throw new IllegalStateException("ASR controller init failed");
        }
        controller = manager.getClass().getMethod("b").invoke(manager);
        Class<?> configClass = loader.loadClass("com.rayneo.airuntime.controller.RayNeoASRConfig");
        Object config = configClass.getConstructor().newInstance();
        set(config, "ServerConfig", loader.loadClass("com.rayneo.airuntime.controller.RayNeoServerConfig"), get(assistantConfig, "ServerConfig"));
        for (String name : new String[]{"UserName", "DeviceName", "DeviceModel", "LanguageCode"}) {
            set(config, name, String.class, get(assistantConfig, name));
        }
        set(config, "InputAudioFormat", String.class, "opus");
        set(config, "InputAudioRate", int.class, 16000);
        set(config, "BizType", String.class, "TELEPROMPTER");
        taskName = "paseo_native_input_" + epoch;
        task = controller.getClass().getMethod("createTask", String.class).invoke(controller, taskName);
        Object recorder = loader.loadClass(HostBindings.ASR_RECORDER).getConstructor().newInstance();
        Class<?> listenerClass = loader.loadClass("com.rayneo.airuntime.controller.ASRResultListener");
        Object callback = Proxy.newProxyInstance(loader, new Class<?>[]{listenerClass}, (proxy, method, args) -> {
            String name = method.getName();
            if (method.getDeclaringClass() == Object.class) {
                if ("hashCode".equals(name)) return System.identityHashCode(proxy);
                if ("equals".equals(name)) return proxy == args[0];
                return "PaseoNativeInputListener";
            }
            if ("onAsrResult".equals(name)) listener.result((String) args[0], (boolean) args[1]);
            else if ("onError".equals(name)) listener.error((int) args[0]);
            else if ("onStartResult".equals(name) && !Boolean.TRUE.equals(args[0])) listener.error(-1);
            return null;
        });
        Method init = task.getClass().getMethod("initTask", configClass,
            loader.loadClass("com.rayneo.airuntime.bridge.AudioRecorderBridge$AudioRecorderAdapter"), listenerClass);
        if (!Boolean.TRUE.equals(init.invoke(task, config, recorder, callback))) throw new IllegalStateException("ASR task init failed");
        feed = recorder.getClass().getMethod("notifyRecordData", byte[].class);
        if (!Boolean.TRUE.equals(task.getClass().getMethod("startTask").invoke(task))) throw new IllegalStateException("ASR task start failed");
        adapter = recorder;
        // Reuse the native microphone control. No teleprompter/subtitle display is started.
        Class<?> recorderClass = loader.loadClass(HostBindings.MICROPHONE);
        nativeRecorder = recorderClass.getField("a").get(null);
        recorderClass.getMethod("a", String.class, boolean.class).invoke(nativeRecorder, "paseo_background_input", true);
    }
    synchronized void offer(Object message) throws Exception {
        Object current = adapter;
        if (current == null) return;
        Object data = message.getClass().getMethod("getData").invoke(message);
        byte[] audio = (byte[]) data.getClass().getMethod(HostBindings.AUDIO_BYTES_METHOD).invoke(data);
        feed.invoke(current, (Object) audio);
    }
    synchronized void stop() {
        adapter = null;
        Object old = task; task = null;
        if (old != null) {
            try { old.getClass().getMethod("stopTask").invoke(old); } catch (Exception ignored) {}
            try { old.getClass().getMethod("releaseTask").invoke(old); } catch (Exception ignored) {}
        }
        if (controller != null && taskName != null) {
            try { controller.getClass().getMethod("destroyTask", String.class).invoke(controller, taskName); } catch (Exception ignored) {}
        }
        controller = null; taskName = null;
        if (nativeRecorder != null) {
            try { nativeRecorder.getClass().getMethod("a", String.class, boolean.class).invoke(nativeRecorder, "paseo_background_input_stop", false); }
            catch (Exception ignored) {}
            nativeRecorder = null;
        }
    }
}
