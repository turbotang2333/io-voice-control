package cn.yilu.rayneopaseo;

import java.nio.charset.StandardCharsets;

/** One explicit experimental opt-in; stores no question or answer text. */
final class ReplyReadingGate {
    private long epoch, armedAt;
    private boolean armed, pending;
    void arm(long now) { epoch++; armedAt = now; armed = true; pending = false; }
    boolean armed(long now) {
        if (armed && (now < armedAt || now - armedAt >= 300000)) armed = false;
        return armed;
    }
    long claim(long now, String outcome, String question, String answer) {
        if (!armed(now) || !"idle".equals(outcome) || question == null || question.trim().isEmpty()
            || VoiceCommand.isControl(question) || VoiceCommand.isExit(question)
            || answer == null || answer.trim().isEmpty()) return -1;
        armed = false;
        if (answer.getBytes(StandardCharsets.UTF_8).length > 8192) return -1;
        pending = true;
        return epoch;
    }
    boolean pending(long token) { return pending && token == epoch; }
    void cancel() { epoch++; armed = pending = false; }
}
