package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;

public final class ShortcutBindingsTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static void reject(Runnable action) {
        boolean rejected = false; try { action.run(); } catch (IllegalArgumentException | IllegalStateException expected) { rejected = true; }
        check(rejected);
    }
    private static ShortcutBindings.Entry entry(String id, String phrase, String agent) {
        return new ShortcutBindings.Entry(id, phrase, "agent", "host-one", "w1", agent, "日常", "记录");
    }
    public static void main(String[] args) {
        InteractionPreferences vocab = InteractionPreferences.defaults();
        ShortcutBindings first = ShortcutBindings.empty().with(entry("one", "记笔记\n随手记", "a1"), vocab);
        check(first.match("随手记。").agentId.equals("a1"));
        check(first.match(" 记 笔 记 ").id.equals("one"));
        check(first.match("我想随手记一下") == null);
        check(first.match("记笔记今天下雨") == null);
        ShortcutBindings loaded = ShortcutBindings.fromStored(first.values(), vocab);
        check(loaded.entries().size() == 1 && loaded.match("记笔记").agentId.equals("a1"));
        for (String word : new String[]{"确认发送", "确认，发送", "查找对话随手记", "下一页", "小雷小雷", "选择2"}) {
            reject(() -> first.with(entry("two", word, "a2"), vocab));
        }
        reject(() -> first.with(entry("two", "随手记！", "a2"), vocab));
        InteractionPreferences aliases = vocab.withChanges(java.util.Collections.singletonMap("alias.current", "随手记"));
        reject(() -> ShortcutBindings.fromStored(first.values(), aliases));
        ShortcutBindings workspace = ShortcutBindings.empty().with(new ShortcutBindings.Entry("workspace", "进入星域", "workspace",
            "host-one", "w2", "", "星域", ""), vocab);
        check(workspace.match("进入星域").agentId.isEmpty());
        check(!workspace.values().containsValue("seed-agent"));
        String legacyId = "D:\\示例 工作区\\记录";
        ShortcutBindings legacy = ShortcutBindings.empty().with(new ShortcutBindings.Entry("legacy", "进入记录", "workspace",
            "host-one", legacyId, "", "记录", ""), vocab);
        check(ShortcutBindings.fromStored(legacy.values(), vocab).match("进入记录").workspaceId.equals(legacyId));
        ShortcutBindings legacyAgent = ShortcutBindings.empty().with(new ShortcutBindings.Entry("legacy-agent", "记录一下", "agent",
            "host-one", legacyId, "a2", "记录", "记录助手"), vocab);
        check(ShortcutBindings.fromStored(legacyAgent.values(), vocab).match("记录一下").workspaceId.equals(legacyId));
        reject(() -> ShortcutBindings.empty().with(new ShortcutBindings.Entry("invalid", "进入记录", "workspace",
            "host-one", "D:\\示例\n工作区", "", "记录", ""), vocab));
        final Map<String, String> disk = new HashMap<>(first.values());
        final boolean[] writable = {true};
        ShortcutSettings settings = new ShortcutSettings(new ShortcutSettings.Store() {
            public Map<String, ?> read() { return disk; }
            public boolean commit(Map<String, String> values) { if (!writable[0]) return false; disk.clear(); disk.putAll(values); return true; }
        }, vocab);
        check(settings.valid());
        writable[0] = false;
        reject(() -> settings.save(entry("one", "随便聊聊", "a2"), vocab));
        check(settings.current().match("随手记").agentId.equals("a1"));
        writable[0] = true; settings.save(entry("one", "随便聊聊", "a2"), vocab);
        check(settings.current().match("随手记") == null);
        check(settings.current().match("随便聊聊").agentId.equals("a2"));
        settings.remove("one", vocab); check(settings.current().entries().isEmpty());
        disk.put("shortcuts.version", "bad");
        ShortcutSettings broken = new ShortcutSettings(new ShortcutSettings.Store() {
            public Map<String, ?> read() { return disk; }
            public boolean commit(Map<String, String> values) { return true; }
        }, vocab);
        check(!broken.valid());

        NativeInputTrial input = new NativeInputTrial(); Object source = new Object();
        input.configure(vocab); input.configureShortcuts(first); input.arm(true);
        input.accept(source, "记笔记", false, "s1");
        ShortcutBindings second = ShortcutBindings.empty().with(entry("one", "记笔记", "a2"), vocab);
        input.configureShortcuts(second);
        input.accept(source, "记笔记", true, "s1");
        check(input.inputFinished() && input.shortcut().agentId.equals("a1"));
        check(input.question().equals("记笔记"));
        check(input.nextTurn(source));
        input.acceptBackground(source, "记笔记", true, "s2");
        check(input.shortcut().agentId.equals("a2"));
        input.stop(); input.arm(true);
        input.accept(source, "原有正文", true, "s3");
        int length = input.draftLength();
        input.accept(source, "记笔记", true, "s4");
        check(!input.inputFinished() && input.shortcut() == null && input.draftLength() == length);
        check(input.takeInputHint().contains("未发送"));
        input.accept(source, "确认发送", true, "s5");
        check(input.question().equals("原有正文") && input.shortcut() == null);

        final Map<String, String> vocabularyDisk = new HashMap<>();
        InteractionSettings vocabulary = new InteractionSettings(new InteractionSettings.Store() {
            public Map<String, ?> read() { return vocabularyDisk; }
            public boolean commit(Map<String, String> values) { vocabularyDisk.putAll(values); return true; }
        });
        vocabulary.setValidator(next -> ShortcutBindings.fromStored(first.values(), next));
        reject(() -> vocabulary.save(java.util.Collections.singletonMap("alias.current", "随手记")));
        check(vocabularyDisk.isEmpty());
        System.out.println("Shortcut bindings checks passed");
    }
}
