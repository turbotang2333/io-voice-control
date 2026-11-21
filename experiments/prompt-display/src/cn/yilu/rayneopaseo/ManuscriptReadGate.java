package cn.yilu.rayneopaseo;

/** Transfer completion gates reading; absent optional display ACKs do not force early exit. */
final class ManuscriptReadGate {
    private final long start;
    private final long pauseDelayMs;
    private long confirmedAt = -1;
    private boolean pauseTaken, closed;
    ManuscriptReadGate(long start) { this(start, 3500); }
    ManuscriptReadGate(long start, long pauseDelayMs) {
        if (pauseDelayMs < 0) throw new IllegalArgumentException("negative pause delay");
        this.start = start;
        this.pauseDelayMs = pauseDelayMs;
    }
    boolean shouldStop(long now) {
        return closed || now < start || now - start >= 60000 || (confirmedAt < 0 && now - start >= 25000);
    }
    boolean fileConfirmed(long now) {
        if (confirmedAt >= 0 || shouldStop(now)) return false;
        confirmedAt = now;
        return true;
    }
    boolean fileUpdated(long now) {
        if (confirmedAt < 0 || shouldStop(now)) return false;
        confirmedAt = now;
        pauseTaken = false;
        return true;
    }
    boolean takePause(long now) {
        if (shouldStop(now) || confirmedAt < 0 || pauseTaken || now - confirmedAt < pauseDelayMs) return false;
        pauseTaken = true;
        return true;
    }
    void close() { closed = true; }
}
