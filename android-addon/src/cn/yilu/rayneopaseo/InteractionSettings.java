package cn.yilu.rayneopaseo;

import java.util.Map;

/** Atomic publication; saving preferences never changes connection ownership or a running turn. */
final class InteractionSettings {
    interface Store { Map<String, ?> read(); boolean commit(Map<String, String> values); }
    interface Validator { void validate(InteractionPreferences next); }
    private Validator validator;
    private final Store store;
    private InteractionPreferences current;
    private boolean valid;
    InteractionSettings(Store store) {
        this.store = store;
        try { current = InteractionPreferences.fromStored(store.read()); valid = true; }
        catch (RuntimeException failure) { current = InteractionPreferences.defaults(); valid = false; }
    }
    synchronized InteractionPreferences current() { return current; }
    synchronized boolean valid() { return valid; }
    synchronized void setValidator(Validator validator) { this.validator = validator; }
    synchronized void save(Map<String, String> changes) { publish(current.withChanges(changes)); }
    synchronized void restoreDefaults() { publish(InteractionPreferences.defaults()); }
    private void publish(InteractionPreferences next) {
        if (validator != null) validator.validate(next);
        boolean committed;
        try { committed = store.commit(next.values()); } catch (RuntimeException failure) { committed = false; }
        if (!committed) throw new IllegalStateException("保存失败，仍使用原设置，请检查手机存储");
        current = next; valid = true;
    }
}
