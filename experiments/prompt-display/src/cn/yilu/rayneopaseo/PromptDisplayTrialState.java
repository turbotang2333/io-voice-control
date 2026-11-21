package cn.yilu.rayneopaseo;

/** Disposable probe lifecycle. Audio counts are unbound observations, not ASR proof. */
final class PromptDisplayTrialState {
    static final long HANDSHAKE_MS = 8000, DURATION_MS = 60000;
    enum Route { PROMPT, CAPTION_OVER_PROMPT }
    private final String sid;
    final Route route;
    private final long startedAt;
    private boolean closed, accepted;
    private int frames;
    private long audioPackets;

    PromptDisplayTrialState(String sid, Route route, long now) {
        if (sid == null || sid.isEmpty() || route == null) throw new IllegalArgumentException();
        this.sid = sid; this.route = route; startedAt = now;
    }
    String sid() { return sid; }
    boolean closed() { return closed; }
    boolean accepted() { return accepted && !closed; }
    boolean pageAcknowledged() { return accepted; }
    int frames() { return frames; }
    long unboundAudioPackets() { return audioPackets; }
    boolean acknowledge(String business, String incomingSid, int code, long now) {
        if (expired(now) || accepted || !"PROACTIVE_AI".equals(business) || !sid.equals(incomingSid)) return false;
        if (code != 1) { close(); return false; }
        accepted = true;
        return true;
    }
    boolean remoteExit(String business, String incomingSid) {
        if (closed || !sid.equals(incomingSid) || !("PROACTIVE_AI".equals(business)
            || (route == Route.CAPTION_OVER_PROMPT && "AI_SUBTITLE".equals(business)))) return false;
        return close();
    }
    void observeUnboundAudio(String business, int type) {
        if (accepted() && "PROACTIVE_AI".equals(business) && type == 4) audioPackets++;
    }
    boolean expired(long now) {
        return closed || now < startedAt || now - startedAt >= DURATION_MS
            || (!accepted && now - startedAt >= HANDSHAKE_MS);
    }
    int nextFrame(long now) {
        if (!accepted() || expired(now) || frames >= 3 || now - startedAt < frames * 15000L) return -1;
        return frames;
    }
    boolean locallyQueuedFrame(int frame, long now) {
        if (frame < 0 || frame != nextFrame(now)) return false;
        frames++;
        return true;
    }
    boolean close() { if (closed) return false; closed = true; return true; }
}
