package cn.yilu.rayneopaseo;

import java.util.*;
import java.nio.file.*;

public class SettingsRecoveryTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    static Map<String, Map<String, Object>> snapshot(long epoch) {
        Map<String, Map<String, Object>> result = new LinkedHashMap<>();
        for (String name : SettingsSnapshot.NAMES) result.put(name, new HashMap<String, Object>());
        Map<String, Object> connection = result.get(SettingsSnapshot.NAMES[0]);
        connection.put("mode", 0); connection.put("port", 18468); connection.put("token", "fixture-token");
        connection.put("navigation_owner", "11111111-2222-3333-4444-555555555555");
        connection.put("navigation_epoch", epoch);
        result.get(SettingsSnapshot.NAMES[1]).putAll(InteractionPreferences.defaults().values());
        return result;
    }
    static class Store implements RecoveryTransaction.Store {
        Map<String, Map<String, Object>> values = snapshot(30);
        byte[] journal; int writes, failAt = -1; boolean permanentFailure, loseJournal;
        public Map<String, Map<String, Object>> read() { return SettingsSnapshot.decode(SettingsSnapshot.encode(values)); }
        public boolean replace(String name, Map<String, Object> next) {
            if (++writes == failAt || permanentFailure) return false;
            values.put(name, new HashMap<>(next)); return true;
        }
        public byte[] journal() { return journal; }
        public void saveJournal(byte[] value) { if (!loseJournal) journal = value.clone(); }
        public void clearJournal() { journal = null; }
    }
    static void rejects(Runnable action) { try { action.run(); throw new AssertionError("accepted invalid recovery"); } catch (IllegalArgumentException | IllegalStateException expected) {} }
    public static void main(String[] args) throws Exception {
        Map<String, Map<String, Object>> original = snapshot(12);
        original.get(SettingsSnapshot.NAMES[0]).put("futureFlag", true);
        original.get(SettingsSnapshot.NAMES[0]).put("futureFloat", 1.25f);
        original.get(SettingsSnapshot.NAMES[0]).put("futureSet", new HashSet<>(Arrays.asList("甲", "乙")));
        byte[] plain = SettingsSnapshot.encode(original);
        check(original.equals(SettingsSnapshot.decode(plain)));
        check(Arrays.equals(plain, SettingsSnapshot.encode(SettingsSnapshot.decode(plain))));
        byte[] trailing = Arrays.copyOf(plain, plain.length + 1); rejects(() -> SettingsSnapshot.decode(trailing));
        Map<String, Map<String, Object>> bad = snapshot(12); bad.put("official-account", new HashMap<>());
        rejects(() -> SettingsSnapshot.encode(bad));
        Map<String, Map<String, Object>> scoped = snapshot(12);
        ShortcutBindings.Entry entry = new ShortcutBindings.Entry("test", "进入测试", "agent", "codex-host", "project", "thread", "项目", "测试对话");
        scoped.put(SettingsSnapshot.NAMES[2], ShortcutScopes.replace(scoped.get(SettingsSnapshot.NAMES[2]), "codex",
            ShortcutBindings.empty().with(entry, InteractionPreferences.defaults()).values()));
        SettingsSnapshot.validate(scoped);
        Map<String, Map<String, Object>> localMode = snapshot(12);
        localMode.get(SettingsSnapshot.NAMES[0]).put("connection.backend", "mika");
        localMode.get(SettingsSnapshot.NAMES[0]).put("mika.configured", true);
        localMode.get(SettingsSnapshot.NAMES[0]).put("mode", 3);
        SettingsSnapshot.validate(localMode);
        check("thread".equals(ShortcutBindings.fromStored(ShortcutScopes.read(SettingsSnapshot.decode(SettingsSnapshot.encode(scoped)).get(SettingsSnapshot.NAMES[2]), "codex"), InteractionPreferences.defaults()).match("进入测试").agentId));
        scoped.get(SettingsSnapshot.NAMES[2]).put("codex.shortcut.test.agentId", "../invalid");
        rejects(() -> SettingsSnapshot.validate(scoped));
        byte[] key = new byte[32]; Arrays.fill(key, (byte)7);
        byte[] archive = RecoveryArchive.encrypt(plain, key);
        check(Arrays.equals(plain, RecoveryArchive.decrypt(archive, key)));
        byte[] other = key.clone(); other[0] = 8; rejects(() -> RecoveryArchive.decrypt(archive, other));
        byte[] tampered = archive.clone(); tampered[tampered.length-1] ^= 1;
        rejects(() -> RecoveryArchive.decrypt(tampered, key));
        check(!Arrays.equals(archive, RecoveryArchive.encrypt(plain, key)));
        Store store = new Store();
        RecoveryTransaction.restore(store, original, 50, 0, false);
        check(store.values.get(SettingsSnapshot.NAMES[0]).get("navigation_epoch").equals(51L));
        check(store.values.get(SettingsSnapshot.NAMES[0]).get("navigation_owner").equals(original.get(SettingsSnapshot.NAMES[0]).get("navigation_owner")));
        check(store.journal == null && store.writes == 3);
        Store busy = new Store(); rejects(() -> RecoveryTransaction.restore(busy, original, 50, 1, false));
        rejects(() -> RecoveryTransaction.restore(busy, original, 50, 0, true)); check(busy.writes == 0 && busy.journal == null);
        Store failed = new Store(); byte[] before = SettingsSnapshot.encode(failed.read()); failed.failAt = 2;
        rejects(() -> RecoveryTransaction.restore(failed, original, 50, 0, false));
        check(Arrays.equals(before, SettingsSnapshot.encode(failed.read())) && failed.journal == null);
        Store crashed = new Store(); crashed.journal = before; crashed.values = snapshot(99);
        RecoveryTransaction.recover(crashed); check(Arrays.equals(before, SettingsSnapshot.encode(crashed.read())) && crashed.journal == null);
        Store blocked = new Store(); blocked.journal = before; blocked.permanentFailure = true;
        rejects(() -> RecoveryTransaction.recover(blocked)); check(blocked.journal != null);
        Store noJournal = new Store(); noJournal.loseJournal = true;
        rejects(() -> RecoveryTransaction.restore(noJournal, original, 50, 0, false)); check(noJournal.writes == 0);
        Map<String, Map<String, Object>> badIdentity = snapshot(12);
        badIdentity.get(SettingsSnapshot.NAMES[0]).put("navigation_owner", "invalid");
        Store untouched = new Store(); rejects(() -> RecoveryTransaction.restore(untouched, badIdentity, 50, 0, false)); check(untouched.writes == 0);
        Files.write(Paths.get(args[0], "fixture.bin"), plain); Files.write(Paths.get(args[0], "fixture.rpb"), archive);
        System.out.println("settings recovery checks passed");
    }
}
