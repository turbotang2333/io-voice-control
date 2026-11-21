package cn.yilu.rayneopaseo;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;

/** Disposable final-answer handoff, installed only with the display experiment. */
final class ReplyReadingTrial {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ReplyReadingGate GATE = new ReplyReadingGate();
    private static Context app;
    private static long pendingToken = -1;
    private static String status = "未启用回答阅读接力";
    static void install(Context context) {
        app = context.getApplicationContext();
        ProbeAddon.setCompletedReplyObserver(ReplyReadingTrial::completed);
    }
    static boolean active() { return GATE.armed(SystemClock.elapsedRealtime()) || GATE.pending(pendingToken); }
    static String summary() { return "回答阅读接力：" + status; }
    static void arm() {
        GATE.arm(SystemClock.elapsedRealtime());
        status = "已准备，五分钟内下一次普通提问的完整回答将转入阅读；本地口令不触发";
        trace("armed");
        Toast.makeText(app, "请正常唤醒、提问并确认发送；下一份回答将自动转阅读", Toast.LENGTH_LONG).show();
    }
    static void cancel() {
        if (!active()) return;
        GATE.cancel(); pendingToken = -1; status = "已取消"; trace("cancelled");
    }
    private static boolean completed(Object source, String question, String answer, String outcome) {
        boolean wasArmed = GATE.armed(SystemClock.elapsedRealtime());
        final long token = GATE.claim(SystemClock.elapsedRealtime(), outcome, question, answer);
        if (token < 0) {
            if (wasArmed && !"idle".equals(outcome)) trace("not_eligible outcome="
                + (outcome == null ? "unknown" : outcome.replaceAll("[^a-z]", "")));
            if (wasArmed && !GATE.armed(SystemClock.elapsedRealtime())) {
                status = "回答超过本轮 8192 字节上限，保持助手显示，不截断正文";
                trace("skipped reason=oversized");
            }
            return false;
        }
        pendingToken = token;
        final String device;
        try {
            device = PromptDisplayTrial.connectedDevice();
            if (!ProbeAddon.closeForReplyReading(source)) {
                GATE.cancel(); status = "本轮对话已变化，未切换"; return false;
            }
        } catch (Exception failure) {
            GATE.cancel(); status = "结束助手失败，请在眼镜上退出后重新唤醒";
            trace("failed phase=assistant_close cause=" + failure.getClass().getSimpleName());
            return true;
        }
        status = "助手已请求退出，准备显示同一份完整回答";
        trace("assistant_closed answerCharacters=" + answer.length());
        MAIN.postDelayed(() -> {
            if (!GATE.pending(token)) return;
            try {
                PromptDisplayTrial.checkIdle();
                if (!device.equals(PromptDisplayTrial.connectedDevice())) throw new IllegalStateException("device changed");
                ManuscriptDisplayTrial.startText(app, answer);
                status = "同一份完整回答已交给稿件通道，实际衔接待镜片确认";
                trace("manuscript_started answerCharacters=" + answer.length());
            } catch (Exception failure) {
                status = "打开稿件失败，请重新唤醒助手";
                trace("failed phase=manuscript_start cause=" + failure.getClass().getSimpleName());
                Toast.makeText(app, "切换阅读失败，请重新唤醒助手", Toast.LENGTH_LONG).show();
            } finally { GATE.cancel(); pendingToken = -1; }
        }, 1000);
        return true;
    }
    private static void trace(String value) { Log.i("PaseoReplyReading", value); }
}
