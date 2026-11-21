package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;

/** Keeps the legacy backup namespace and Paseo keys while isolating Codex bindings. */
final class ShortcutScopes {
    private static final String PREFIX = "codex.";
    private ShortcutScopes() {}
    private static String prefix(String backend) {
        if ("paseo".equals(backend)) return "";
        if ("codex".equals(backend)) return PREFIX;
        throw new IllegalArgumentException("未知快捷方式模式");
    }
    static Map<String, Object> read(Map<String, ?> all, String backend) {
        String prefix = prefix(backend); Map<String, Object> result = new HashMap<>();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            if (prefix.isEmpty() ? !entry.getKey().startsWith(PREFIX) : entry.getKey().startsWith(prefix))
                result.put(prefix.isEmpty() ? entry.getKey() : entry.getKey().substring(prefix.length()), entry.getValue());
        }
        return result;
    }
    static Map<String, Object> replace(Map<String, ?> all, String backend, Map<String, String> values) {
        String prefix = prefix(backend); Map<String, Object> result = new HashMap<>();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            boolean own = prefix.isEmpty() ? !entry.getKey().startsWith(PREFIX) : entry.getKey().startsWith(prefix);
            if (!own) result.put(entry.getKey(), entry.getValue());
        }
        for (Map.Entry<String, String> entry : values.entrySet()) result.put(prefix + entry.getKey(), entry.getValue());
        if (!prefix.isEmpty() && read(result, "paseo").isEmpty()) result.putAll(ShortcutBindings.empty().values());
        return result;
    }
}
