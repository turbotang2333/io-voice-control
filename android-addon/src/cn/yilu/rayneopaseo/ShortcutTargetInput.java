package cn.yilu.rayneopaseo;

import java.util.Locale;

/** Explicit source selection; an empty pasted ID never chooses a different target. */
final class ShortcutTargetInput {
    static final class Request {
        final String seed;
        final boolean keepExisting;
        Request(String seed, boolean keepExisting) { this.seed = seed; this.keepExisting = keepExisting; }
    }
    static Request resolve(String source, String seed, String kind, String existingKind) {
        if (!"agent".equals(kind) && !"workspace".equals(kind)) throw new IllegalArgumentException("请选择绑定类型");
        if ("existing".equals(source)) {
            if (existingKind == null || !kind.equals(existingKind))
                throw new IllegalArgumentException("绑定类型已变化，请粘贴对话 ID 或选择使用当前选择");
            return new Request("", true);
        }
        if ("current".equals(source)) return new Request("", false);
        if (!"id".equals(source)) throw new IllegalArgumentException("请选择目标来源");
        String value = seed == null ? "" : seed.trim();
        if (value.isEmpty()) throw new IllegalArgumentException("请粘贴 Codex 对话 ID，或选择使用当前选择");
        if (!value.matches("[A-Za-z0-9_-]{1,128}"))
            throw new IllegalArgumentException("请只粘贴 Codex 对话 ID，不要包含链接或说明文字");
        if (value.matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")) value = value.toLowerCase(Locale.ROOT);
        return new Request(value, false);
    }
}
