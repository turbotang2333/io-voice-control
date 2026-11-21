package cn.yilu.rayneopaseo;

/** A matching prepare success registers one file task; other replies are observations only. */
final class ManuscriptPrepareGate {
    private boolean transferred, closed;
    boolean takeTransfer(int action, int code) {
        if (closed || transferred || action != 2 || code != 1) return false;
        transferred = true;
        return true;
    }
    void close() { closed = true; }
}
