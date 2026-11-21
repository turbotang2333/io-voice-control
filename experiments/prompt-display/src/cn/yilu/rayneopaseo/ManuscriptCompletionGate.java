package cn.yilu.rayneopaseo;

/** Own completed-read requests only. Duplicate replies are bounded to fifteen seconds. */
final class ManuscriptCompletionGate {
    private final String document, device;
    private long completedAt = -1;
    private boolean closed;
    ManuscriptCompletionGate(String document, String device) { this.document = document; this.device = device; }
    synchronized boolean consume(long now, String actualDevice, String actualDocument,
        int type, int action, int code, boolean completed) {
        if (closed || now < 0 || !device.equals(actualDevice) || !document.equals(actualDocument)
            || type != 4 || action != 1 || code != 1 || !completed) return false;
        if (completedAt >= 0 && !canAck(now)) return false;
        if (completedAt < 0) completedAt = now;
        return true;
    }
    synchronized boolean canAck(long now) {
        return !closed && completedAt >= 0 && now >= completedAt && now - completedAt < 15000;
    }
    synchronized void close() { closed = true; }
}
