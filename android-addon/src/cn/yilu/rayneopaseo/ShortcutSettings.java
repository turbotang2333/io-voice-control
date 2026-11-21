package cn.yilu.rayneopaseo;

import java.util.Map;

/** Publishes a complete snapshot only after its own private preference file commits successfully. */
final class ShortcutSettings {
    interface Store { Map<String, ?> read(); boolean commit(Map<String, String> values); }
    private final Store store;
    private ShortcutBindings current;
    private boolean valid;
    ShortcutSettings(Store store, InteractionPreferences vocabulary) {
        this.store = store;
        try { current = ShortcutBindings.fromStored(store.read(), vocabulary); valid = true; }
        catch (RuntimeException failure) { current = ShortcutBindings.empty(); valid = false; }
    }
    synchronized ShortcutBindings current() { return current; }
    synchronized boolean valid() { return valid; }
    synchronized void validateVocabulary(InteractionPreferences next) {
        if (valid) ShortcutBindings.fromStored(current.values(), next);
    }
    synchronized void save(ShortcutBindings.Entry entry, InteractionPreferences vocabulary) {
        if (!valid) throw new IllegalStateException("快捷方式配置无法读取，请先清空快捷方式");
        publish(current.with(entry, vocabulary));
    }
    synchronized void remove(String id, InteractionPreferences vocabulary) { publish(current.without(id, vocabulary)); }
    synchronized void restore() { publish(ShortcutBindings.empty()); }
    private void publish(ShortcutBindings next) {
        boolean committed;
        try { committed = store.commit(next.values()); } catch (RuntimeException failure) { committed = false; }
        if (!committed) throw new IllegalStateException("快捷方式保存失败，仍使用原设置，请检查手机存储");
        current = next; valid = true;
    }
}
