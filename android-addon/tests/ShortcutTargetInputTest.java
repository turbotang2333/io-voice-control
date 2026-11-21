package cn.yilu.rayneopaseo;

public final class ShortcutTargetInputTest {
    private static int checks;
    private static void ok(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    private static void rejected(String source, String seed, String kind, String existing) {
        try { ShortcutTargetInput.resolve(source, seed, kind, existing); throw new AssertionError("accepted invalid input"); }
        catch (IllegalArgumentException expected) { checks++; }
    }
    public static void main(String[] args) {
        String copied = "11111111-2222-4333-8444-AAAAAAAAAAAA";
        ShortcutTargetInput.Request id = ShortcutTargetInput.resolve("id", " \n" + copied + "\n", "agent", null);
        ok(id.seed.equals(copied.toLowerCase(java.util.Locale.ROOT))); ok(!id.keepExisting);
        rejected("id", "", "agent", null);
        rejected("id", "codex://threads/" + copied, "agent", null);
        rejected("id", "Thread ID: " + copied, "agent", null);
        rejected("id", "one two", "agent", null);
        rejected("id", new String(new char[129]).replace('\0', 'a'), "agent", null);
        ShortcutTargetInput.Request current = ShortcutTargetInput.resolve("current", "ignored", "agent", "agent");
        ok(current.seed.isEmpty()); ok(!current.keepExisting);
        ShortcutTargetInput.Request retained = ShortcutTargetInput.resolve("existing", "", "workspace", "workspace");
        ok(retained.seed.isEmpty()); ok(retained.keepExisting);
        rejected("existing", "", "agent", null);
        rejected("existing", "", "workspace", "agent");
        rejected("unknown", "a", "agent", null);
        rejected("id", "a", "unknown", null);
        ok(ShortcutTargetInput.resolve("id", "thread_A", "workspace", "workspace").seed.equals("thread_A"));
        System.out.println(checks + " checks passed");
    }
}
