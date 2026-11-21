package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;

public final class ShortcutScopesTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        InteractionPreferences vocabulary = InteractionPreferences.defaults();
        ShortcutBindings.Entry paseo = new ShortcutBindings.Entry("p", "进入工作", "agent", "paseo-host", "workspace", "a", "项目", "Paseo 对话");
        ShortcutBindings.Entry codex = new ShortcutBindings.Entry("c", "进入工作", "agent", "codex-host", "project", "b", "项目", "Codex 对话");
        Map<String, Object> values = new HashMap<>();
        values.putAll(ShortcutBindings.empty().with(paseo, vocabulary).values());
        Map<String, Object> both = ShortcutScopes.replace(values, "codex", ShortcutBindings.empty().with(codex, vocabulary).values());
        check("a".equals(ShortcutBindings.fromStored(ShortcutScopes.read(both, "paseo"), vocabulary).match("进入工作").agentId));
        check("b".equals(ShortcutBindings.fromStored(ShortcutScopes.read(both, "codex"), vocabulary).match("进入工作").agentId));
        check(ShortcutScopes.read(values, "codex").isEmpty());
        Map<String, Object> reset = ShortcutScopes.replace(both, "codex", ShortcutBindings.empty().values());
        check(ShortcutBindings.fromStored(ShortcutScopes.read(reset, "codex"), vocabulary).entries().isEmpty());
        check("a".equals(ShortcutBindings.fromStored(ShortcutScopes.read(reset, "paseo"), vocabulary).match("进入工作").agentId));
        // Starting with Codex alone leaves a valid empty legacy Paseo group for rollback.
        Map<String, Object> firstCodex = ShortcutScopes.replace(new HashMap<String, Object>(), "codex", ShortcutBindings.empty().with(codex, vocabulary).values());
        check(ShortcutBindings.fromStored(firstCodex, vocabulary).entries().isEmpty());
        check("b".equals(ShortcutBindings.fromStored(ShortcutScopes.read(firstCodex, "codex"), vocabulary).match("进入工作").agentId));
        check(BackendCapabilities.accepts("codex", "codex", true));
        check(BackendCapabilities.accepts("paseo", "paseo", true));
        check(!BackendCapabilities.accepts("codex", "paseo", true));
        check(!BackendCapabilities.accepts("paseo", "codex", true));
        check(!BackendCapabilities.accepts("codex", "codex", false));
        check(!BackendCapabilities.accepts("official", "official", true));
        System.out.println("shortcut scopes checks passed");
    }
}
