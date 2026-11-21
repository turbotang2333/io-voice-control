package cn.yilu.rayneopaseo;

import java.util.function.LongSupplier;

/** No Android dependencies: identity and cancellation rules for one voice turn. */
public final class TurnGate {
    private static final long CONTINUATION_GAP_MS = 5000;
    private final LongSupplier clock;
    private Object source;
    private String question = "", session = "", lastIdentity = "";
    private long generation, finalAt;
    private boolean finalSeen, owned, done;
    public TurnGate() { this(() -> System.nanoTime() / 1000000L); }
    TurnGate(LongSupplier clock) { this.clock = clock; }
    public synchronized boolean recognize(Object owner, String text, boolean finished, String sid) {
        if (text == null || text.isEmpty()) return false;
        long now = clock.getAsLong();
        boolean continuing = finalSeen && !owned && source == owner && now >= finalAt
            && now - finalAt <= CONTINUATION_GAP_MS;
        if (!finished) {
            if (!continuing) { reset(); lastIdentity = ""; }
            return false;
        }
        String identity = System.identityHashCode(owner) + "\n" + sid + "\n" + text;
        if (identity.equals(lastIdentity)) return false;
        if (continuing) question += separator(question, text) + text;
        else { reset(); source = owner; question = text; }
        lastIdentity = identity; finalAt = now;
        session = sid == null ? "" : sid; finalSeen = true; return true;
    }
    private static String separator(String before, String after) {
        if (before.isEmpty() || after.isEmpty()) return "";
        char last = before.charAt(before.length() - 1), first = after.charAt(0);
        if (Character.isWhitespace(last) || Character.isWhitespace(first)
            || "，。！？；：、,.;!?".indexOf(last) >= 0 || "，。！？；：、,.;!?".indexOf(first) >= 0) return "";
        return "，";
    }
    public synchronized long beginReply(Object owner, String sid) {
        if (!matches(owner, sid) || owned || done) return -1;
        owned = true; return generation;
    }
    private boolean matches(Object owner, String sid) {
        return finalSeen && source == owner && (session.isEmpty() || sid == null || sid.isEmpty() || session.equals(sid));
    }
    public synchronized boolean owns(Object owner, String sid) { return owned && matches(owner, sid); }
    public synchronized boolean pending() { return finalSeen && !done; }
    public synchronized boolean accepts(long token) { return owned && !done && token == generation; }
    public synchronized boolean complete(long token) { if (!accepts(token)) return false; done = true; return true; }
    public synchronized void release(long token) { if (generation == token) owned = false; }
    public synchronized void reset() { generation++; source = null; question = ""; session = ""; lastIdentity = ""; finalAt = 0; finalSeen = owned = done = false; }
    public synchronized String question() { return question; }
    public synchronized String session() { return session; }
}
