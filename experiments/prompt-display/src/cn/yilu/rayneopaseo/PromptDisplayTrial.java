package cn.yilu.rayneopaseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** Disposable display probes; no independent ASR initialization or network requests. */
public final class PromptDisplayTrial {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile PromptDisplayTrialState current;
    private static volatile Object nativeAssistantPlugin;
    private static Context app;
    private static boolean captionQueued;
    private static int font = 2, lines = 5, configReplies;
    private static boolean stopLocallyQueued;
    private static String lastSummary = "尚未开始";
    private PromptDisplayTrial() {}

    public static void install(Activity activity) {
        if (Looper.myLooper() != Looper.getMainLooper()) { MAIN.post(() -> install(activity)); return; }
        app = activity.getApplicationContext();
        ReplyReadingTrial.install(app);
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (!(root instanceof FrameLayout) || root.findViewWithTag("paseo-display-trial") != null) return;
        TextView entry = new TextView(activity);
        entry.setTag("paseo-display-trial"); entry.setText("显示实验");
        entry.setTextColor(Color.WHITE); entry.setBackgroundColor(Color.rgb(95, 55, 15));
        entry.setPadding(18, 12, 18, 12); entry.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.RIGHT);
        layout.topMargin = (int) (150 * activity.getResources().getDisplayMetrics().density);
        root.addView(entry, layout);
        entry.setOnClickListener(view -> show(activity));
    }

    public static void observeTeleprompterAsr(Object source, String text, boolean finished) {
        ManuscriptDisplayTrial.observeTeleprompterAsr(text, finished);
    }
    public static void observeTeleprompterAudioStart(Object source) {
        ManuscriptDisplayTrial.observeTeleprompterAudioEvent("record_start", 1);
    }
    public static void observeTeleprompterAudioEnd(Object source) {
        ManuscriptDisplayTrial.observeTeleprompterAudioEvent("record_end", 0);
    }
    public static void observeTeleprompterAsrStartResult(Object source, boolean success) {
        ManuscriptDisplayTrial.observeTeleprompterAudioEvent("asr_start", success ? 1 : 0);
    }
    public static void observeTeleprompterAsrError(Object source, int code) {
        ManuscriptDisplayTrial.observeTeleprompterAudioEvent("asr_error", code);
    }
    public static void observeTeleprompterVadStatus(Object source, int status) {
        ManuscriptDisplayTrial.observeTeleprompterAudioEvent("vad", status);
    }

    private static void show(Activity activity) {
        String status = current == null ? lastSummary : summary(current, "进行中");
        if (!ManuscriptDisplayTrial.summary().isEmpty()) status = ManuscriptDisplayTrial.summary();
        status += "\n" + ReplyReadingTrial.summary();
        status += "\n" + ReaderWakeHandoff.summary();
        new AlertDialog.Builder(activity, android.R.style.Theme_Material_Light_Dialog_Alert)
            .setTitle("提词器式显示最小实验")
            .setMessage("先结束当前对话。稿件实验使用固定测试稿，打开后暂停阅读，60 秒后请求退出；增量实验在约 14 秒和 28 秒时追加文字。\n"
                + "助手启动实验会请求眼镜进入收听；先只观察界面，不用说问题或确认发送。稿件接力仅在本轮识别到唤醒词时触发。\n"
                + "一次性回答接力需你正常提问并确认发送，回答完成后结束收音、转入同文阅读。实验本身不会主动发消息。\n\n" + status)
            .setPositiveButton("选择实验", (dialog, which) -> choose(activity))
            .setNegativeButton("停止实验", (dialog, which) -> stop("manual"))
            .setNeutralButton("关闭面板", null).show();
    }

    private static void choose(Activity activity) {
        String[] cases = {"稿件提词器，固定稿件暂停阅读", "稿件增量，三批文字原页更新", "语音路径诊断，稿件滚动18秒后暂停", "唤醒接力实验，停止稿件后请求助手", "一次性接力，下次回答后自动阅读", "历史对照：提示页", "历史对照：字幕页，字号 2，5 行", "历史对照：字幕页，字号 1，7 行", "单独唤起助手，真实镜片启动请求"};
        new AlertDialog.Builder(activity, android.R.style.Theme_Material_Light_Dialog_Alert)
            .setTitle("一次只运行一种显示")
            .setItems(cases, (dialog, which) -> {
                if (current != null || ManuscriptDisplayTrial.active() || ReaderWakeHandoff.active()) { toast("请先停止当前实验"); return; }
                if (which == 4) { ReplyReadingTrial.arm(); return; }
                if (ReplyReadingTrial.active()) { toast("请先停止回答接力实验"); return; }
                if (which == 8) {
                    try { ReaderWakeHandoff.startFromHome(); toast("已发起助手启动实验，请观察镜片"); }
                    catch (Exception failure) { toast("请先结束当前对话并检查眼镜连接"); }
                    return;
                }
                if (which <= 3) {
                    try {
                        checkIdle();
                        if (which == 2) ManuscriptDisplayTrial.startScrollingAudio(app);
                        else if (which == 3) ManuscriptDisplayTrial.startWakeHandoff(app);
                        else ManuscriptDisplayTrial.start(app, which == 1);
                    }
                    catch (Exception failure) { toast("请先结束当前对话并检查眼镜连接"); }
                } else start(which - 5);
            }).setNegativeButton("取消", null).show();
    }

    public static void observeNativeAssistantPlugin(Object plugin) {
        if (plugin != null) nativeAssistantPlugin = plugin;
    }

    static boolean startNativeAssistantFromWake(String expectedDevice) {
        Object plugin = nativeAssistantPlugin;
        if (plugin == null || app == null) {
            trace("reader_wake_handoff started=false reason=plugin_unavailable");
            return false;
        }
        String stage = "check_idle";
        try {
            checkIdle();
            if (!expectedDevice.equals(connectedDevice())) throw new IllegalStateException("device changed");
            ClassLoader loader = app.getClassLoader();
            stage = "load_glass_sender";
            Class<?> senderType = loader.loadClass("com.rayneo.rayneo_venus_sdk_plugin.e");
            if (senderType.getField("e").getBoolean(null)) throw new IllegalStateException("SDK mock mode active");
            Object sender = senderType.getField("a").get(null);
            // Stock 1.0.4.12 MessageProcessor::dispatchMessage routes type 9 to
            // handleAppStart. rc=1 attempts a real wake, with canWakeup checks.
            // This is distinct from type 2 recorder control / iOS MFI pull-up,
            // and from the SDK's phone-only voice_assistant_trigger_wake mock.
            stage = "queue_glass_app_start";
            boolean queued = (Boolean) senderType.getMethod("k", senderType, int.class, String.class)
                .invoke(null, sender, 9, new JSONObject().put("rc", 1).toString());
            trace("reader_wake_handoff app_start_type=9 rc=1 locally_queued=" + queued);
            return queued;
        } catch (Exception failure) {
            Throwable cause = failure;
            while (cause.getCause() != null && cause != cause.getCause()) cause = cause.getCause();
            trace("reader_wake_handoff started=false stage=" + stage + " reason="
                + failure.getClass().getSimpleName() + " cause=" + cause.getClass().getSimpleName());
            return false;
        }
    }

    static void checkIdle() throws Exception {
        for (String name : new String[]{"connectionBusy", "connectionDraftChars"}) {
            Method method = ProbeAddon.class.getDeclaredMethod(name); method.setAccessible(true);
            Object value = method.invoke(null);
            if (Boolean.TRUE.equals(value) || (value instanceof Number && ((Number) value).intValue() > 0))
                throw new IllegalStateException("请先处理现有草稿或等待回复，再结束对话");
        }
        Field input = ProbeAddon.class.getDeclaredField("NATIVE_INPUT_TRIAL"); input.setAccessible(true);
        if (((NativeInputTrial) input.get(null)).active()) throw new IllegalStateException("请先在眼镜上说结束对话");
        connectedDevice();
    }
    static String connectedDevice() throws Exception {
        Map<?, ?> devices = (Map<?, ?>) app.getClassLoader().loadClass("X3.u").getMethod("h").invoke(null);
        if (devices.size() != 1) throw new IllegalStateException("请只连接一副眼镜后重试");
        Object device = devices.values().iterator().next();
        return (String) device.getClass().getField("a").get(device);
    }

    private static void start(int selected) {
        if (current != null) { toast("请先停止当前实验"); return; }
        try { checkIdle(); }
        catch (Exception failure) { toast(failure instanceof IllegalStateException ? failure.getMessage() : "暂不能开始显示实验"); return; }
        font = selected == 2 ? 1 : 2; lines = selected == 2 ? 7 : 5;
        captionQueued = false; configReplies = 0; stopLocallyQueued = false;
        PromptDisplayTrialState state = new PromptDisplayTrialState(UUID.randomUUID().toString().replace("-", ""),
            selected == 0 ? PromptDisplayTrialState.Route.PROMPT : PromptDisplayTrialState.Route.CAPTION_OVER_PROMPT,
            SystemClock.elapsedRealtime());
        current = state;
        try {
            JSONObject settings = new JSONObject().put("mode", "conversation").put("source_language", "zh-CN")
                .put("target_language", "zh-CN").put("save_audio", false).put("direction", "ahead");
            if (!queue("PROACTIVE_AI", 1, new JSONObject().put("sid", state.sid()).put("trigger", 1)
                .put("force", false).put("code", 0).put("settings", settings))) { stop("start_failed"); return; }
            trace("started route=" + state.route.name());
            toast("请观察镜片；最多 60 秒后自动退出");
            tick(state);
        } catch (Exception failure) { stop("start_failed"); }
    }

    private static void tick(PromptDisplayTrialState state) {
        if (current != state) return;
        long now = SystemClock.elapsedRealtime();
        if (state.expired(now)) { stop(state.accepted() ? "timeout" : "handshake_timeout"); return; }
        try { checkIdle(); } catch (Exception failure) { stop("assistant_or_device_changed"); return; }
        int frame = state.nextFrame(now);
        if (frame >= 0) {
            try {
                String text = "第" + (frame + 1) + "屏，固定显示样本\n01 项目和对话名称\n02 测试文字完整显示\n"
                    + "03 保留标点、数字和换行\n04 这一行检查字号\n05 这一行检查行距\n"
                    + "06 这一行检查下方边界\n07 第" + (frame + 1) + "屏结束";
                JSONObject content = new JSONObject().put("source_transcript", text);
                if (state.route == PromptDisplayTrialState.Route.PROMPT)
                    content.put("target_translation", "固定文字已更新为第" + (frame + 1) + "屏")
                        .put("keyword_info", JSONObject.NULL).put("label", 0);
                if (!queue(state.route == PromptDisplayTrialState.Route.PROMPT ? "PROACTIVE_AI" : "AI_SUBTITLE", 5,
                    new JSONObject().put("sid", state.sid()).put("mode", state.route == PromptDisplayTrialState.Route.PROMPT ? 4 : 3)
                        .put("status", 1).put("content", content))) { stop("text_failed"); return; }
                state.locallyQueuedFrame(frame, now);
                trace("frame_locally_queued count=" + state.frames() + " unboundAudioPackets=" + state.unboundAudioPackets());
            } catch (Exception failure) { stop("text_failed"); return; }
        }
        MAIN.postDelayed(() -> tick(state), 500);
    }

    public static void observePacket(Object packet) {
        ManuscriptDisplayTrial.observePacket(packet);
        // Decode on the receiver thread; only counts/control metadata cross to MAIN.
        PromptDisplayTrialState state = current;
        if (state == null) return;
        try {
                String business = ((Enum<?>) packet.getClass().getField("p").get(packet)).name();
                if (!"PROACTIVE_AI".equals(business) && !"AI_SUBTITLE".equals(business)) return;
                byte[] bytes = (byte[]) packet.getClass().getField("i").get(packet);
                Class<?> typeClass = app.getClassLoader().loadClass("com.rayneo.airuntime.tansport.proto.TransportMessage$CaptionMsg");
                Object message = typeClass.getMethod("parseFrom", byte[].class).invoke(null, (Object) bytes);
                int type = (int) typeClass.getMethod("getType").invoke(message);
                if (type == 4) {
                    MAIN.post(() -> { if (current == state) state.observeUnboundAudio(business, type); });
                    return;
                }
                if (type != 2 && type != 3 && type != 8) return;
                JSONObject metadata = new JSONObject((String) typeClass.getMethod("getMessage").invoke(message));
                String sid = metadata.optString("sid");
                if (!state.sid().equals(sid)) return;
                int code = metadata.optInt("code", -1);
                MAIN.post(() -> control(state, business, type, sid, code));
        } catch (Exception failure) {
            MAIN.post(() -> { if (current == state) stop("packet_failed"); });
        }
    }

    public static void observeFileShareSuccess(Object source, String task, Object device, Object role, String name, String path) {
        ManuscriptDisplayTrial.fileSucceeded(task);
    }
    public static void observeFileShareFailure(Object source, String task, Object device, Object role, Object error) {
        ManuscriptDisplayTrial.fileFailed(task);
    }
    public static void observeManuscriptSend(Object source, Object request, Object callback) {
        ManuscriptDisplayTrial.observeSend(request);
    }
    public static boolean consumePacket(Object device, Object packet) {
        ReaderWakeHandoff.observePacket(device, packet);
        return ManuscriptDisplayTrial.consumeCompletion(device, packet);
    }

    private static void control(PromptDisplayTrialState state, String business, int type, String sid, int code) {
        if (current != state) return;
        try {
                if (state.expired(SystemClock.elapsedRealtime())) { stop("timeout"); return; }
                if (type == 3 && state.remoteExit(business, sid)) { stop("remote_exit"); return; }
                if (type == 8 && state.route == PromptDisplayTrialState.Route.CAPTION_OVER_PROMPT && "AI_SUBTITLE".equals(business)) {
                    configReplies++; trace("config_response code=" + code);
                }
                if (type == 2 && state.acknowledge(business, sid, code, SystemClock.elapsedRealtime())) {
                    trace("page_acknowledged");
                    if (state.route == PromptDisplayTrialState.Route.CAPTION_OVER_PROMPT) {
                        JSONObject config = new JSONObject().put("font_size", font).put("content_width", 100)
                            .put("max_lines", lines).put("position", "center").put("is_display", true).put("straight_view", "original");
                        captionQueued = queue("AI_SUBTITLE", 7, new JSONObject().put("sid", state.sid()).put("force", false)
                            .put("scope", "temporary").put("config", config));
                        if (!captionQueued) stop("layout_failed");
                    }
                } else if (state.closed()) stop("page_rejected");
        } catch (Exception failure) { stop("packet_failed"); }
    }

    private static boolean queue(String business, int type, JSONObject value) {
        return LensPromptProbe.sendChecked(app, business, type, value);
    }
    private static void stop(String reason) {
        ReaderWakeHandoff.cancel();
        ReplyReadingTrial.cancel();
        PromptDisplayTrialState state = current;
        if (state == null) { ManuscriptDisplayTrial.stop(reason); return; }
        state.close(); current = null;
        try {
            boolean captionStop = !captionQueued || queue("AI_SUBTITLE", 3,
                new JSONObject().put("sid", state.sid()).put("reason_code", 10).put("text", ""));
            boolean promptStop = queue("PROACTIVE_AI", 3,
                new JSONObject().put("sid", state.sid()).put("reason_code", 2).put("text", ""));
            stopLocallyQueued = captionStop && promptStop;
        } catch (Exception ignored) { trace("stop_queue_failed"); }
        retire(state, reason);
    }
    private static void retire(PromptDisplayTrialState state, String reason) {
        if (current == state) current = null;
        state.close(); lastSummary = summary(state, reason); captionQueued = false;
        trace("stopped reason=" + reason + " frames=" + state.frames() + " unboundAudioPackets=" + state.unboundAudioPackets());
        toast(stopLocallyQueued ? "已请求退出实验，请重新唤醒检查原对话恢复" : "退出请求未完全发出，请在眼镜上手动退出");
    }
    private static String summary(PromptDisplayTrialState state, String reason) {
        return "状态：" + reason + "\n提示页确认：" + (state.pageAcknowledged() ? "已收到" : "未收到")
            + "\n本机排队文字：" + state.frames() + " 屏\n未绑定会话的收音包：" + state.unboundAudioPackets()
            + "\n字幕配置回包：" + configReplies + "\n退出请求本机排队：" + stopLocallyQueued
            + "\n是否可读、是否退出及恢复语音，仍须镜片确认。";
    }
    private static void toast(String value) { if (app != null) Toast.makeText(app, value, Toast.LENGTH_LONG).show(); }
    private static void trace(String value) { Log.i("PaseoDisplayTrial", value); }
}
