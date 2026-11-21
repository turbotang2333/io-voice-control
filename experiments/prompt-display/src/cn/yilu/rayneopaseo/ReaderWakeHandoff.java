package cn.yilu.rayneopaseo;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONObject;

/** Finite, opt-in handoff. Incoming messages continue through the stock SDK. */
final class ReaderWakeHandoff {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile ReaderWakeHandoffGate pending;
    private static String status = "尚未运行助手启动实验";
    private ReaderWakeHandoff() {}
    static boolean active() { return pending != null; }
    static String summary() { return "阅读返回助手：" + status; }

    static void startFromHome() throws Exception {
        PromptDisplayTrial.checkIdle();
        if (active()) throw new IllegalStateException("handoff already pending");
        ReaderWakeHandoffGate gate = new ReaderWakeHandoffGate(PromptDisplayTrial.connectedDevice(), null, now());
        pending = gate;
        request(gate);
        watch(gate);
    }
    static boolean awaitReaderStop(String device, String did) {
        if (active()) return false;
        ReaderWakeHandoffGate gate = new ReaderWakeHandoffGate(device, did, now());
        pending = gate;
        status = "等待本轮稿件停止回包";
        trace("waiting_reader_stop");
        watch(gate);
        return true;
    }
    private static void request(ReaderWakeHandoffGate gate) {
        if (pending != gate) return;
        if (!PromptDisplayTrial.startNativeAssistantFromWake(gate.device)) {
            finish(gate, "助手启动请求未发出", "request_failed");
            return;
        }
        status = "真实启动请求已排队，等待眼镜唤醒事件；界面仍需确认";
        trace("startup_locally_queued");
    }
    static void observePacket(Object device, Object packet) {
        ReaderWakeHandoffGate gate = pending;
        if (gate == null) return;
        try {
            String source = (String) device.getClass().getField("a").get(device);
            if (!gate.device.equals(source)) return;
            String business = ((Enum<?>) packet.getClass().getField("p").get(packet)).name();
            if (!"TELEPROMPTER".equals(business) && !"VOICE_ASSISTANT".equals(business)) return;
            ManuscriptTransfer.Proto message = ManuscriptTransfer.Proto.read((byte[]) packet.getClass().getField("i").get(packet));
            int type = (int) message.number(2);
            if ("VOICE_ASSISTANT".equals(business)) {
                if (type != 1) return; // Never decode speech, audio or model output.
                MAIN.post(() -> {
                    if (pending == gate && gate.takeWake(source, type, now()))
                        finish(gate, "收到眼镜唤醒事件，是否进入助手仍需镜片确认", "glass_wake_observed");
                });
                return;
            }
            if (type != 6) return;
            JSONObject body = new JSONObject(message.text(3));
            String did = body.optString("did");
            int action = body.optInt("action", -1), code = body.optInt("code", -1);
            MAIN.post(() -> {
                if (pending != gate) return;
                if (gate.takeStop(source, did, type, action, code, now())) {
                    trace("reader_stop_acknowledged mode_exit_unverified=true");
                    request(gate);
                } else if (gate.closed()) finish(gate, "停止稿件被拒绝或已超时，未继续唤起", "reader_stop_rejected_or_late");
            });
        } catch (Exception failure) {
            trace("packet_observation_failed cause=" + failure.getClass().getSimpleName());
        }
    }
    static void cancel() {
        ReaderWakeHandoffGate gate = pending;
        if (gate != null) finish(gate, "接力已取消", "cancelled");
    }
    private static void watch(ReaderWakeHandoffGate gate) {
        MAIN.postDelayed(() -> {
            if (pending != gate) return;
            if (gate.closed() || gate.expired(now())) finish(gate, "等待眼镜回报超时，未自动重试", "timeout");
            else watch(gate);
        }, 250);
    }
    private static void finish(ReaderWakeHandoffGate gate, String value, String event) {
        if (pending != gate) return;
        gate.close(); pending = null; status = value; trace(event);
    }
    private static long now() { return SystemClock.elapsedRealtime(); }
    private static void trace(String value) { Log.i("PaseoReaderWake", value); }
}
