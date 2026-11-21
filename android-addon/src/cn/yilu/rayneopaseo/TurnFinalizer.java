package cn.yilu.rayneopaseo;

/** Always attempts completion, even when displaying the reply fails or testing is cancelled. */
public final class TurnFinalizer {
    public interface Action { void run() throws Exception; }
    private final Action completion;
    private boolean closed, closing;
    public TurnFinalizer(Action completion) { this.completion = completion; }
    public boolean isClosed() { return closed; }
    public boolean closeSafely() {
        if (closed) return true;
        if (closing) return false;
        closing = true;
        try { completion.run(); closed = true; return true; }
        catch (Exception failure) { return false; }
        finally { closing = false; }
    }
    public boolean finish(Action delivery) {
        if (closed || closing) return false;
        boolean delivered = false;
        try { delivery.run(); delivered = true; }
        catch (Exception failure) { /* Completion is still required. */ }
        finally { closeSafely(); }
        return delivered && closed;
    }
    /** Delivers one answer while leaving a continuous conversation open. */
    public boolean deliver(Action delivery) {
        if (closed || closing) return false;
        try { delivery.run(); return true; }
        catch (Exception failure) { return false; }
    }
}
