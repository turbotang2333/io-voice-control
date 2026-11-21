package cn.yilu.rayneopaseo;

import java.util.Map;
import java.util.HashMap;
import java.util.UUID;

/** Phone identity is an opaque marker, never an authorization credential. */
final class NavigationSession {
    interface Store { Map<String, ?> read(); boolean commit(Map<String, Object> changes); }
    static final class Snapshot {
        final String installationId;
        final long epoch;
        Snapshot(String owner, long value) { installationId = owner; epoch = value; }
    }
    private static final long MAX_EPOCH = 9007199254740991L;
    private Snapshot current;
    private Map<String, Object> confirmed;
    private boolean initialized, uncertain;
    private long attemptedEpoch;
    private String attemptedOwner;
    synchronized void initialize(Store store) {
        if (initialized) return;
        initialized = true;
        current = commitNext(store, new HashMap<String, Object>());
    }
    synchronized void advance(Store store, Map<String, Object> configuration) {
        if (!initialized || confirmed == null) throw new IllegalStateException("导航会话尚未初始化");
        Snapshot next = commitNext(store, configuration);
        current = next;
    }
    synchronized Snapshot current() {
        if (current == null || uncertain) throw new IllegalStateException("导航连接已暂停，请重新保存设置");
        return current;
    }
    synchronized boolean isCurrent(Snapshot snapshot) { return !uncertain && snapshot != null && snapshot == current; }
    synchronized Map<String, ?> configuration() {
        return confirmed == null ? new HashMap<String, Object>() : new HashMap<>(confirmed);
    }
    private Snapshot commitNext(Store store, Map<String, Object> configuration) {
        if (confirmed == null) confirmed = new HashMap<>(store.read());
        Map<String, ?> previous = confirmed;
        Object savedOwner = previous.get("navigation_owner"), savedEpoch = previous.get("navigation_epoch");
        String owner; long epoch;
        if (savedOwner == null && savedEpoch == null) {
            if (attemptedOwner == null) attemptedOwner = UUID.randomUUID().toString();
            owner = attemptedOwner; epoch = attemptedEpoch + 1;
        }
        else {
            if (!(savedOwner instanceof String) || !((String)savedOwner).matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
                || !(savedEpoch instanceof Long || savedEpoch instanceof Integer)) throw new IllegalStateException("导航会话记录无效");
            long value = ((Number)savedEpoch).longValue();
            if (value < 1 || value >= MAX_EPOCH) throw new IllegalStateException("导航会话编号无效或已用尽");
            owner = (String)savedOwner; epoch = Math.max(value, attemptedEpoch) + 1;
            if (current != null && (!current.installationId.equals(owner) || current.epoch != value)) throw new IllegalStateException("导航会话已变化");
        }
        if (epoch < 1 || epoch > MAX_EPOCH) throw new IllegalStateException("导航会话编号已用尽");
        attemptedEpoch = epoch;
        Map<String, Object> changes = new HashMap<>(configuration);
        changes.put("navigation_owner", owner); changes.put("navigation_epoch", epoch);
        uncertain = true;
        boolean saved;
        try { saved = store.commit(changes); } catch (RuntimeException failure) { saved = false; }
        if (!saved) {
            Map<String, Object> rollback = new HashMap<>();
            for (String key : changes.keySet()) rollback.put(key, previous.get(key));
            try { store.commit(rollback); } catch (RuntimeException ignored) {}
            // A failed disk write or failed rollback is uncertain. Keep the last
            // confirmed routing snapshot, but block ALL network sends until an
            // explicit successful save repairs the transaction.
            throw new IllegalStateException("手机保存失败，连接已暂停；请重新保存设置后使用");
        }
        Map<String, Object> next = new HashMap<>(confirmed);
        for (Map.Entry<String, Object> change : changes.entrySet()) {
            if (change.getValue() == null) next.remove(change.getKey()); else next.put(change.getKey(), change.getValue());
        }
        confirmed = next; uncertain = false;
        return new Snapshot(owner, epoch);
    }
}
