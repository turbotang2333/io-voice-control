package cn.yilu.rayneopaseo;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Proxy;
import java.security.SecureRandom;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** A separate manuscript channel probe. No catalog synchronization or ASR initialization. */
final class ManuscriptDisplayTrial {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile Session current;
    private static volatile Session completedSession;
    private static String previous = "";
    private static final class Session {
        final Context app;
        final String did, task, device;
        ManuscriptTransfer transfer;
        final boolean incremental;
        final boolean wakeToAssistant;
        final long start = SystemClock.elapsedRealtime();
        final ManuscriptReadGate readGate;
        final ManuscriptPrepareGate prepareGate = new ManuscriptPrepareGate();
        final ManuscriptCompletionGate completionGate;
        boolean completionAckQueued;
        boolean completionSent, started, pauseQueued, pauseConfirmed, fileConfirmed;
        String nativeTask;
        File cacheFile;
        int revision, confirmedRevisions;
        int teleprompterAsrPartials, teleprompterAsrFinals;
        int readerRecordStarts, readerRecordEnds, readerVadChanges, lastReaderVadStatus = Integer.MIN_VALUE;
        long transferStartedAt;
        boolean transferPending;
        String phase = "等待传输";
        Session(Context app, String device, boolean incremental, String suppliedText, long pauseDelayMs, boolean wakeToAssistant) {
            this.app = app; this.device = device;
            this.incremental = incremental;
            this.wakeToAssistant = wakeToAssistant;
            readGate = new ManuscriptReadGate(start, pauseDelayMs);
            did = uuid7(); task = "task_2_" + System.currentTimeMillis();
            completionGate = new ManuscriptCompletionGate(did, device);
            String text = "稿件提词器显示实验\n第一行：固定测试稿。\n第二行：检查字号和可读性。\n"
                + "第三行：文字应持续停留。\n第四行：不应五秒后消失。\n第五行：观察行距与左右边界。\n"
                + "第六行：本轮没有启动跟读。\n第七行：本轮没有发送 Agent。\n"
                + "第八行：这是独立测试稿。\n第九行：一分钟后请求退出。\n第十行：稿件显示实验结束。";
            transfer = new ManuscriptTransfer(task, did,
                suppliedText != null ? suppliedText : incremental ? incrementalText(0) : text);
        }
    }
    private ManuscriptDisplayTrial() {}
    static boolean active() { return current != null; }
    static String summary() { return current == null ? previous : describe(current); }

    static void observeTeleprompterAsr(String text, boolean finished) {
        Session session = current;
        if (session == null || text == null || text.trim().isEmpty()) return;
        int characters = text.length();
        MAIN.post(() -> {
            if (current != session) return;
            if (finished) session.teleprompterAsrFinals++;
            else session.teleprompterAsrPartials++;
            if (finished || session.teleprompterAsrPartials == 1) {
                trace("reader_asr_observed final=" + finished + " chars=" + characters
                    + " partials=" + session.teleprompterAsrPartials + " finals=" + session.teleprompterAsrFinals
                    + (finished ? " wakeMatch=" + WakePhraseMatcher.matches(text) : ""));
                if (finished && session.wakeToAssistant && WakePhraseMatcher.matches(text)) {
                    trace("reader_wake_matched");
                    MAIN.post(() -> handoffToAssistant(session));
                }
            }
        });
    }

    static void observeTeleprompterAudioEvent(String event, int value) {
        Session session = current;
        if (session == null) return;
        MAIN.post(() -> {
            if (current != session) return;
            if ("record_start".equals(event)) session.readerRecordStarts++;
            else if ("record_end".equals(event)) session.readerRecordEnds++;
            else if ("vad".equals(event)) {
                if (session.lastReaderVadStatus == value) return;
                session.lastReaderVadStatus = value;
                session.readerVadChanges++;
            } else if (!"asr_start".equals(event) && !"asr_error".equals(event)) return;
            trace("reader_audio_event event=" + event + " value=" + value
                + " recordStarts=" + session.readerRecordStarts + " recordEnds=" + session.readerRecordEnds
                + " vadChanges=" + session.readerVadChanges);
        });
    }

    static void start(Context context) throws Exception {
        start(context, false);
    }
    static void start(Context context, boolean incremental) throws Exception {
        start(context, incremental, null);
    }
    static void startScrollingAudio(Context context) throws Exception {
        start(context, false, null, 18000, false);
    }
    static void startWakeHandoff(Context context) throws Exception {
        start(context, false, null, 18000, true);
    }
    static void startText(Context context, String fullAnswer) throws Exception {
        if (fullAnswer == null || fullAnswer.trim().isEmpty()) throw new IllegalArgumentException("empty answer");
        start(context, false, fullAnswer);
    }
    private static void start(Context context, boolean incremental, String suppliedText) throws Exception {
        start(context, incremental, suppliedText, 3500, false);
    }
    private static void start(Context context, boolean incremental, String suppliedText, long pauseDelayMs, boolean wakeToAssistant) throws Exception {
        if (current != null || ReaderWakeHandoff.active()) throw new IllegalStateException("trial already active");
        Map<?, ?> devices = devices(context);
        if (devices.size() != 1) throw new IllegalStateException("expected one device");
        Object connected = devices.values().iterator().next();
        Session session = new Session(context.getApplicationContext(), (String) connected.getClass().getField("a").get(connected), incremental, suppliedText, pauseDelayMs, wakeToAssistant);
        current = session;
        try {
            JSONObject begin = settings(session).put("action", 1);
            if (!sendControl(session, 2, begin)) {
                stop("start_queue_failed"); return;
            }
            trace("started bytes=" + session.transfer.byteCount() + " characters=" + session.transfer.characterCount()
                + " incremental=" + incremental + " completedReply=" + (suppliedText != null)
                + " pauseDelayMs=" + pauseDelayMs + " wakeToAssistant=" + wakeToAssistant);
            toast(session, "稿件显示实验开始，请观察是否进入真正的稿件页面");
            tick(session);
        } catch (Exception failure) { stop("start_failed"); }
    }
    private static JSONObject settings(Session session) throws Exception {
        return new JSONObject().put("countdown", 3).put("scroll", 1).put("speed", 1)
            .put("gear", 1).put("depth", 1).put("size", 18).put("width", 492).put("leading", 4)
            .put("total", session.transfer.characterCount()).put("did", session.did)
            .put("pageOffset", 0).put("highLightOffset", 0);
    }
    private static void tick(Session session) {
        if (current != session) return;
        if (session.readGate.shouldStop(SystemClock.elapsedRealtime())) {
            stop(session.fileConfirmed ? "timeout" : "handshake_timeout"); return;
        }
        try { PromptDisplayTrial.checkIdle(); }
        catch (Exception failure) { stop("assistant_or_device_changed"); return; }
        long now = SystemClock.elapsedRealtime();
        if (session.transferPending && now - session.transferStartedAt >= 10000) {
            stop("revision_transfer_timeout"); return;
        }
        if (session.incremental && !session.transferPending && session.completionSent
            && session.revision < 2 && now - session.start >= (session.revision + 1) * 14000L) {
            session.revision++;
            session.transfer = new ManuscriptTransfer(session.task + "_" + session.revision,
                session.did, incrementalText(session.revision));
            session.completionSent = false;
            session.nativeTask = null;
            session.pauseQueued = session.pauseConfirmed = false;
            trace("revision_requested revision=" + session.revision + " bytes=" + session.transfer.byteCount());
            beginNativeTransfer(session);
            if (current != session) return;
        }
        if (!session.transferPending && session.readGate.takePause(SystemClock.elapsedRealtime())) {
            try {
                session.pauseQueued = sendControl(session, 4, new JSONObject().put("action", 1).put("did", session.did)
                    .put("offset", 0).put("code", 1).put("isCompleted", false));
                session.phase = "稿件已传完，已请求暂停，等待镜片确认";
                trace("pause_locally_queued confirmed=" + session.pauseQueued);
                if (!session.pauseQueued) { stop("pause_queue_failed"); return; }
            } catch (Exception failure) { stop("pause_failed"); return; }
        }
        MAIN.postDelayed(() -> tick(session), 500);
    }

    static void observePacket(Object packet) {
        Session session = current;
        if (session == null) return;
        try {
            String business = ((Enum<?>) packet.getClass().getField("p").get(packet)).name();
            if (!"TELEPROMPTER".equals(business)) return;
            byte[] bytes = (byte[]) packet.getClass().getField("i").get(packet);
            if (bytes.length == 0) return;
            {
                ManuscriptTransfer.Proto message = ManuscriptTransfer.Proto.read(bytes);
                int type = (int) message.number(2);
                if (type != 2 && type != 3 && type != 4 && type != 6 && type != 8) return;
                JSONObject body = new JSONObject(message.text(3));
                // Protobuf field 1 is version in the pinned SDK's CaptionMsg/AssistantMsg.
                // The teleprompter action is inside the JSON body, not the envelope.
                int action = body.optInt("action", 0), code = body.optInt("code", 1);
                trace("control_seen type=" + type + " version=" + message.number(1) + " action=" + action
                    + " didPresent=" + body.has("did") + " ownDid=" + session.did.equals(body.optString("did"))
                    + " codePresent=" + body.has("code") + " code=" + code
                    + " completed=" + body.optBoolean("isCompleted", false)
                    + " offset=" + body.optInt("offset", -1) + " pageOffset=" + body.optInt("pageOffset", -1));
                if (!session.did.equals(body.optString("did"))) return;
                if (type == 8) return; // Progress is diagnostic only; never treat it as an ACK.
                if (type == 6 && action == 1) MAIN.post(() -> retireCompleted(session));
                MAIN.post(() -> controlReply(session, type, action, code));
            }
        } catch (Exception failure) {
            MAIN.post(() -> { if (current == session) stop("packet_decode_failed"); });
        }
    }
    static boolean consumeCompletion(Object device, Object packet) {
        Session primary = current, completed = completedSession;
        if (primary == null && completed == null) return false;
        try {
            if (!"TELEPROMPTER".equals(((Enum<?>) packet.getClass().getField("p").get(packet)).name())) return false;
            ManuscriptTransfer.Proto message = ManuscriptTransfer.Proto.read((byte[]) packet.getClass().getField("i").get(packet));
            JSONObject body = new JSONObject(message.text(3));
            String actualDevice = (String) device.getClass().getField("a").get(device);
            for (Session session : new Session[]{primary, completed}) {
                if (session == null) continue;
                if (session.completionGate.consume(SystemClock.elapsedRealtime(), actualDevice, body.optString("did"),
                    (int) message.number(2), body.optInt("action", 0), body.optInt("code", 0), body.optBoolean("isCompleted", false))) {
                    MAIN.post(() -> acknowledgeCompleted(session));
                    return true;
                }
            }
        } catch (Exception failure) { trace("completion_observation_failed cause=" + failure.getClass().getSimpleName()); }
        return false;
    }
    private static void acknowledgeCompleted(Session session) {
        if (!session.completionGate.canAck(SystemClock.elapsedRealtime())) return;
        try {
            boolean queued = sendControl(session, 4, new JSONObject().put("action", 2).put("did", session.did).put("code", 1));
            session.completionAckQueued |= queued;
            session.phase = queued ? "已回复本轮稿件完成确认，镜片结果待核对" : "完成确认未发出，请手动退出";
            trace("completion_reply_locally_queued ok=" + queued);
            completedSession = session;
            MAIN.postDelayed(() -> { if (completedSession == session) completedSession = null; }, 15000);
        } catch (Exception failure) { trace("completion_reply_failed cause=" + failure.getClass().getSimpleName()); }
    }
    private static void retireCompleted(Session session) {
        if (current != session || !session.completionAckQueued) return;
        current = null; session.readGate.close(); session.prepareGate.close();
        session.phase = "收到本轮稿件结束请求，实际退出待镜片核对";
        previous = describe(session);
        trace("retired reason=owned_reading_completed");
    }
    static void observeSend(Object request) {
        Session session = current;
        if (session == null) return;
        try {
            Object business = request.getClass().getField("c").get(request);
            if (!"TELEPROMPTER".equals(((Enum<?>) business).name())) return;
            byte[] bytes = (byte[]) request.getClass().getField("e").get(request);
            ManuscriptTransfer.Proto message = ManuscriptTransfer.Proto.read(bytes);
            int type = (int) message.number(2);
            if (type != 2 && type != 3 && type != 4 && type != 6 && type != 8) return;
            JSONObject body = new JSONObject(message.text(3));
            if (!session.did.equals(body.optString("did"))) return;
            trace("control_outgoing type=" + type + " version=" + message.number(1)
                + " action=" + body.optInt("action", 0) + " ownDid=true codePresent=" + body.has("code")
                + " code=" + body.optInt("code", -1) + " completed=" + body.optBoolean("isCompleted", false)
                + " offset=" + body.optInt("offset", -1));
        } catch (Exception failure) { trace("outgoing_observation_failed cause=" + failure.getClass().getSimpleName()); }
    }
    private static void beginNativeTransfer(Session session) {
        if (current != session) return;
        try {
            File folder = new File(session.app.getCacheDir(), "paseo-manuscript-trial");
            if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("cache directory unavailable");
            File file = session.cacheFile;
            if (file == null) {
                file = new File(folder, session.did);
                if (!file.createNewFile()) throw new IllegalStateException("test file already exists");
                session.cacheFile = file;
            } else if (!file.isFile() || !file.getCanonicalFile().getParentFile().equals(folder.getCanonicalFile())) {
                throw new IllegalStateException("owned test file unavailable");
            }
            session.transferPending = true;
            session.transferStartedAt = SystemClock.elapsedRealtime();
            try (FileOutputStream output = new FileOutputStream(file)) { output.write(session.transfer.content()); }
            ClassLoader loader = session.app.getClassLoader();
            Class<?> targetClass = loader.loadClass("j4.q");
            @SuppressWarnings({"unchecked", "rawtypes"})
            Object target = Enum.valueOf((Class<? extends Enum>) targetClass, "SmallCore");
            Class<?> transport = loader.loadClass("X3.u");
            session.nativeTask = (String) transport.getMethod("u", File.class, String.class, targetClass, String.class)
                .invoke(transport.getField("h").get(null), file, session.device, target, "");
            if (session.nativeTask == null || session.nativeTask.isEmpty()) throw new IllegalStateException("native file task unavailable");
            session.phase = "原生文件任务已登记，等待传输确认";
            trace("native_file_task_registered bytes=" + session.transfer.byteCount() + " revision=" + session.revision);
        } catch (Exception failure) { trace("native_file_start_failed cause=" + failure.getClass().getSimpleName()); stop("native_file_start_failed"); }
    }
    static void fileSucceeded(String task) {
        MAIN.post(() -> {
            Session session = current;
            if (session == null || session.nativeTask == null || !session.nativeTask.equals(task) || session.completionSent) return;
            boolean accepted = session.fileConfirmed ? session.readGate.fileUpdated(SystemClock.elapsedRealtime())
                : session.readGate.fileConfirmed(SystemClock.elapsedRealtime());
            if (!accepted) { stop("late_file_confirmation"); return; }
            session.fileConfirmed = true; session.completionSent = true; session.transferPending = false;
            session.confirmedRevisions++;
            session.phase = "原生传输已确认，等待页面";
            trace("native_file_confirmed bytes=" + session.transfer.byteCount() + " revision=" + session.revision);
            try {
                // Do not synchronize the manuscript catalog.
                if (!sendControl(session, 3, settings(session).put("action", 1).put("code", 1)
                    .put("checksum", session.transfer.checksum()))) stop("completion_queue_failed");
            } catch (Exception failure) { stop("completion_queue_failed"); }
        });
    }
    static void fileFailed(String task) {
        MAIN.post(() -> {
            Session session = current;
            if (session != null && session.nativeTask != null && session.nativeTask.equals(task)) stop("native_file_failed");
        });
    }
    private static void controlReply(Session session, int type, int action, int code) {
        if (current != session || action != 2) return;
        trace("control_reply type=" + type + " code=" + code);
        if (code != 1) { trace("control_non_success_observed type=" + type + " code=" + code); return; }
        if (type == 2 && session.prepareGate.takeTransfer(action, code)) {
            if (session.readGate.shouldStop(SystemClock.elapsedRealtime())) { stop("late_prepare_reply"); return; }
            trace("prepare_confirmed file_transfer_begin=true");
            beginNativeTransfer(session);
        }
        if (type == 3 && session.completionSent && !session.started) {
            session.started = true; session.phase = "页面启动回包已收到，等待镜片确认";
        } else if (type == 4 && session.pauseQueued) {
            session.pauseConfirmed = true; session.phase = "暂停回包已收到，等待镜片确认";
        } else if (type == 6) {
            session.phase = "收到退出相关回包，实际页面状态待确认";
        }
    }
    static boolean stop(String reason) {
        Session completed = completedSession;
        completedSession = null;
        if (completed != null) completed.completionGate.close();
        Session session = current;
        if (session == null) return false;
        current = null;
        session.readGate.close();
        session.prepareGate.close();
        session.completionGate.close();
        boolean queued = false;
        try { queued = sendControl(session, 6, new JSONObject().put("action", 1).put("did", session.did)); }
        catch (Exception ignored) {}
        session.phase = reason + (queued ? "，退出请求已发出" : "，请在眼镜上手动退出");
        previous = describe(session);
        trace("stopped reason=" + reason + " fileConfirmed=" + session.fileConfirmed
            + " startAck=" + session.started + " pauseQueued=" + session.pauseQueued
            + " pauseConfirmed=" + session.pauseConfirmed + " exitQueued=" + queued
            + " confirmedRevisions=" + session.confirmedRevisions);
        toast(session, queued ? "已请求退出稿件实验，请核对镜片恢复" : "退出请求未发出，请在眼镜上手动退出");
        return queued;
    }
    private static void handoffToAssistant(Session session) {
        if (current != session) return;
        if (!ReaderWakeHandoff.awaitReaderStop(session.device, session.did)) return;
        if (!stop("wake_phrase_matched")) ReaderWakeHandoff.cancel();
    }
    private static String describe(Session session) {
        return "稿件实验：" + session.phase + "\n稿件字节数：" + session.transfer.byteCount()
            + "\n传输确认：" + session.fileConfirmed + "\n暂停回包：" + session.pauseConfirmed
            + (session.incremental ? "\n已确认的文字批次：" + session.confirmedRevisions + "/3" : "")
            + "\n持续显示与退出仍需镜片确认。";
    }
    private static String incrementalText(int revision) {
        String text = "流式显示实验\n第一段：这是第一批文字。";
        if (revision >= 1) text += "\n第二段：新文字已经追加。";
        if (revision >= 2) text += "\n第三段：三批文字已到齐。\n请观察是否闪屏或重新倒计时。";
        return text;
    }
    private static Map<?, ?> devices(Context context) throws Exception {
        return (Map<?, ?>) context.getClassLoader().loadClass("X3.u").getMethod("h").invoke(null);
    }
    private static boolean sendControl(Session session, int type, JSONObject body) {
        return send(session, "TELEPROMPTER", ManuscriptTransfer.Proto.join(
            ManuscriptTransfer.Proto.number(1, 1), ManuscriptTransfer.Proto.number(2, type),
            ManuscriptTransfer.Proto.text(3, body.toString()), ManuscriptTransfer.Proto.bytes(4, new byte[0])));
    }
    private static boolean send(Session session, String businessName, byte[] bytes) {
        try {
            Map<?, ?> devices = devices(session.app);
            if (devices.size() != 1) return false;
            Object connected = devices.values().iterator().next();
            if (!session.device.equals(connected.getClass().getField("a").get(connected))) return false;
            ClassLoader loader = session.app.getClassLoader();
            @SuppressWarnings({"rawtypes", "unchecked"})
            Object business = Enum.valueOf((Class<? extends Enum>) loader.loadClass("i4.h"), businessName);
            Class<?> request = loader.loadClass("X3.Q"), callback = loader.loadClass("kotlin.jvm.functions.Function2");
            Object envelope = request.getConstructor(byte[].class, String.class, business.getClass(), String.class, String.class)
                .newInstance(bytes, session.device, business, UUID.randomUUID().toString(), "");
            Object listener = Proxy.newProxyInstance(loader, new Class<?>[]{callback}, (proxy, method, args) -> {
                if (method.getDeclaringClass() == Object.class) {
                    if ("hashCode".equals(method.getName())) return System.identityHashCode(proxy);
                    if ("equals".equals(method.getName())) return proxy == args[0];
                    return "ManuscriptDisplayTrialCallback";
                }
                return null;
            });
            Class<?> transport = loader.loadClass("X3.u");
            transport.getMethod("t", request, callback).invoke(transport.getField("h").get(null), envelope, listener);
            return true;
        } catch (Exception failure) { trace("queue_failed business=" + businessName + " cause=" + failure.getClass().getSimpleName()); return false; }
    }
    private static String uuid7() {
        byte[] bytes = new byte[16]; new SecureRandom().nextBytes(bytes);
        long now = System.currentTimeMillis();
        for (int i = 0; i < 6; i++) bytes[i] = (byte) (now >>> ((5 - i) * 8));
        bytes[6] = (byte) ((bytes[6] & 15) | 0x70); bytes[8] = (byte) ((bytes[8] & 63) | 0x80);
        java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(bytes);
        return new UUID(buffer.getLong(), buffer.getLong()).toString();
    }
    private static void toast(Session session, String text) { Toast.makeText(session.app, text, Toast.LENGTH_LONG).show(); }
    private static void trace(String text) { Log.i("PaseoManuscriptTrial", text); }
}
