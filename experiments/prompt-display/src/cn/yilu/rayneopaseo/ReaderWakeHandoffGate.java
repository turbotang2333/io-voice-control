package cn.yilu.rayneopaseo;

/** A stop ACK ends the document, not necessarily the teleprompter application. */
final class ReaderWakeHandoffGate {
    final String device;
    private final String did;
    private long deadline;
    private int phase; // 0: document stop, 1: glasses wake event, 2: closed

    ReaderWakeHandoffGate(String device, String did, long now) {
        this.device = device;
        this.did = did;
        phase = did == null ? 1 : 0;
        deadline = now + 8000;
    }
    boolean takeStop(String source, String document, int type, int action, int code, long now) {
        if (expired(now) || phase != 0 || !device.equals(source) || !did.equals(document)
            || type != 6 || action != 2) return false;
        if (code != 1) { close(); return false; }
        phase = 1;
        deadline = now + 8000;
        return true;
    }
    boolean takeWake(String source, int type, long now) {
        if (expired(now) || phase != 1 || type != 1 || !device.equals(source)) return false;
        close();
        return true;
    }
    boolean expired(long now) {
        if (phase == 2 || now < deadline) return false;
        close();
        return true;
    }
    boolean closed() { return phase == 2; }
    void close() { phase = 2; }
}
