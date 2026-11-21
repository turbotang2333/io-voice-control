package cn.yilu.rayneopaseo;

import java.util.Map;
import java.util.Arrays;

/** Journal remains until every preference file is restored or rolled back. */
final class RecoveryTransaction {
    interface Store {
        Map<String, Map<String, Object>> read();
        boolean replace(String name, Map<String, Object> values);
        byte[] journal(); void saveJournal(byte[] bytes); void clearJournal();
    }
    private RecoveryTransaction() {}
    private static void replace(Store store, Map<String, Map<String, Object>> groups) {
        for (String name : SettingsSnapshot.NAMES) if (!store.replace(name, groups.get(name))) throw new IllegalStateException("Settings commit failed");
    }
    static void recover(Store store) {
        byte[] pending = store.journal(); if (pending == null) return;
        replace(store, SettingsSnapshot.decode(pending)); store.clearJournal();
    }
    static void restore(Store store, Map<String, Map<String, Object>> snapshot, long epochFloor, int draftChars, boolean busy) {
        if (draftChars > 0 || busy) throw new IllegalStateException("Finish or cancel the current turn before restoring");
        if (store.journal() != null) throw new IllegalStateException("An interrupted restore must be recovered first");
        SettingsSnapshot.validate(snapshot);
        Map<String, Map<String, Object>> next = SettingsSnapshot.decode(SettingsSnapshot.encode(snapshot));
        Map<String, Map<String, Object>> previous = store.read();
        Map<String, Object> values = next.get(SettingsSnapshot.NAMES[0]), current = previous.get(SettingsSnapshot.NAMES[0]);
        long epoch = SettingsSnapshot.epoch(values);
        if (values.get("navigation_owner").equals(current.get("navigation_owner"))) epoch = Math.max(epoch, SettingsSnapshot.epoch(current));
        if (epochFloor < 0 || epochFloor >= 9007199254740989L) throw new IllegalArgumentException("Invalid navigation epoch floor");
        values.put("navigation_epoch", Math.max(epoch, epochFloor) + 1);
        byte[] journal = SettingsSnapshot.encode(previous);
        store.saveJournal(journal);
        if (!Arrays.equals(journal, store.journal())) throw new IllegalStateException("Restore journal was not committed; settings are unchanged");
        try { replace(store, next); store.clearJournal(); }
        catch (RuntimeException failure) {
            try { recover(store); } catch (RuntimeException ignored) { /* Keep journal and block startup. */ }
            throw new IllegalStateException("Settings restore failed; interrupted transactions block extension startup");
        }
    }
}
