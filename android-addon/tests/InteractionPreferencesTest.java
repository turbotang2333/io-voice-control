package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;

public final class InteractionPreferencesTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    static void equal(String actual, String expected) { if (!expected.equals(actual)) throw new AssertionError(actual + " != " + expected); }
    static Map<String, String> change(String key, String value) { Map<String, String> m = new HashMap<>(); m.put(key, value); return m; }
    static void rejects(InteractionPreferences base, String key, String value) {
        try { base.withChanges(change(key, value)); throw new AssertionError("must reject: " + key); }
        catch (IllegalArgumentException expected) { }
    }
    public static void main(String[] args) {
        InteractionPreferences base = InteractionPreferences.defaults();
        for (String id : new String[]{"permission", "offline", "timeout", "unknown", "error", "search_mode", "creation_mode"})
            check(!base.text(id).contains("Paseo") && !base.text(id).contains("只支持"));
        Map<String, Object> legacy = new HashMap<>();
        legacy.put("text.timeout", "等待超时，请查看 Paseo 原会话，不要重复发送。");
        legacy.put("text.permission", "Paseo 正等待授权，请在手机或电脑上处理。");
        legacy.put("text.unknown", "这是我自定义的连接提示");
        InteractionPreferences migrated = InteractionPreferences.fromStored(legacy);
        equal(migrated.text("timeout"), base.text("timeout"));
        equal(migrated.text("permission"), base.text("permission"));
        equal(migrated.text("unknown"), "这是我自定义的连接提示");
        equal(base.text("working"), "（回复中）");
        equal(base.text("complete"), "（本轮完成）");
        equal(base.text("creating"), "（正在创建）");
        InteractionPreferences creation = base.withChanges(change("alias.create", "新增聊天"))
            .withChanges(change("text.creation_success", "创建成功。"));
        equal(creation.resolve("新增聊天 Push test。").text, "新建对话Push test");
        equal(creation.resolve("新增聊天").text, "新建对话");
        equal(creation.localize("新对话已创建并选中。\n项目：测试"), "创建成功。\n项目：测试");
        equal(creation.localize("这是新对话已创建并选中。"), "这是新对话已创建并选中。");
        rejects(base, "alias.create", "确认发送");
        InteractionPreferences custom = base.withChanges(change("alias.confirm", "发给助手"))
            .withChanges(change("alias.search", "搜索聊天"))
            .withChanges(change("alias.browse_first", "回到开头"))
            .withChanges(change("alias.select", "切到{数字}"))
            .withChanges(change("alias.jump", "阅读第{数字}部分"))
            .withChanges(change("text.working", "（正在回复）"));
        equal(custom.resolve("发给助手。").text, "确认发送");
        equal(custom.resolve("确认发送").text, "确认发送");
        equal(custom.resolve("搜索聊天 PROJECTDELTA 身份认证").text, "查找对话PROJECTDELTA身份认证");
        equal(custom.resolve("搜索聊天").text, "查找对话");
        equal(custom.resolve("请帮我回到开头").text, "从头浏览");
        check(!custom.resolve("切到第三个").hint.isEmpty()); // A malformed reserved prefix must never become an Agent question.
        equal(custom.resolve("切到三").text, "选择3");
        check(!custom.resolve("切到那个").hint.isEmpty());
        check(!custom.resolve("阅读第那个部分").hint.isEmpty());
        equal(custom.resolve("阅读第十二部分").text, "第12段");
        equal(custom.resolve("阅读第零部分").text, "第0段");
        equal(custom.resolve("请解释回到开头这句话").action, "");
        equal(base.text("working"), "（回复中）");
        equal(custom.text("working"), "（正在回复）");
        equal(InteractionPreferences.fromStored(custom.values()).text("working"), "（正在回复）");
        rejects(base, "alias.confirm", "下一页");
        // The send gate ignores internal punctuation. Another action must not
        // acquire a spelling that would submit an existing draft instead.
        rejects(base, "alias.help", "确认：发送");
        rejects(base, "alias.help", "确:认发送");
        rejects(base, "alias.help", "取消：发送");
        rejects(base, "alias.select", "确认：发送{数字}");
        rejects(base, "alias.help", "：：");
        rejects(base, "alias.select", "：：{数字}");
        rejects(base, "alias.help", "小雷：小雷");
        rejects(base, "alias.search", "确认");
        rejects(base, "alias.confirm", "选择三");
        rejects(base, "alias.confirm", "好");
        rejects(base, "alias.confirm", "小雷小雷");
        rejects(base, "alias.jump", "阅读数字");
        rejects(base, "alias.select", "{数字}");
        rejects(base, "text.working", "第一行\n第二行");
        rejects(base, "text.working", "一\n二\n三");
        rejects(base, "text.working", new String(new char[30]).replace('\0', '字'));
        rejects(custom, "alias.cancel", "发给助手");
        InteractionPreferences prompts = base.withChanges(change("text.permission", "请在手机授权。"));
        equal(prompts.localize("Paseo 正等待授权，请在手机或电脑上处理。"), "请在手机授权。");
        equal(prompts.localize("这是 Agent 自己说的话"), "这是 Agent 自己说的话");
        Map<String, Object> stored = new HashMap<>();
        boolean[] writable = {true};
        InteractionSettings settings = new InteractionSettings(new InteractionSettings.Store() {
            public Map<String, ?> read() { return new HashMap<>(stored); }
            public boolean commit(Map<String, String> values) { if (!writable[0]) return false; stored.clear(); stored.putAll(values); return true; }
        });
        settings.save(change("text.working", "（请稍候）"));
        InteractionPreferences snapshot = settings.current();
        writable[0] = false;
        try { settings.save(change("text.working", "（等待中）")); throw new AssertionError(); } catch (IllegalStateException expected) { }
        equal(settings.current().text("working"), "（请稍候）");
        writable[0] = true;
        settings.restoreDefaults();
        equal(snapshot.text("working"), "（请稍候）");
        equal(settings.current().text("working"), "（回复中）");
        stored.put("alias.confirm", "下一页");
        InteractionSettings broken = new InteractionSettings(new InteractionSettings.Store() {
            public Map<String, ?> read() { return stored; }
            public boolean commit(Map<String, String> values) { stored.clear(); stored.putAll(values); return true; }
        });
        check(!broken.valid());
        broken.restoreDefaults(); check(broken.valid());
        System.out.println("interaction preferences checks passed");
    }
}
