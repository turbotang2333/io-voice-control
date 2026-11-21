package cn.yilu.rayneopaseo;

import java.util.Map;
import java.util.HashMap;

/** Keep the on-disk preference update atomic, including migration of old tokens. */
final class ConnectionSecrets {
    private static final String[] KEYS = {"token", "connection.paseo.token", "connection.codex.token"};
    private ConnectionSecrets() {}
    static Map<String,Object> read(Map<String,?> values, SecretEnvelope codec) {
        Map<String,Object> result = new HashMap<>(values);
        for (String key : KEYS) {
            Object value = result.get(key);
            if (value instanceof String && ((String)value).startsWith(SecretEnvelope.PREFIX)) {
                String decoded = codec.open((String)value), label = key + "\u0000";
                if (!decoded.startsWith(label)) throw new IllegalStateException("连接信息不匹配");
                result.put(key, decoded.substring(label.length()));
            }
        }
        return result;
    }
    static Map<String,Object> protectChanges(Map<String,?> current, Map<String,Object> changes, SecretEnvelope codec) {
        Map<String,Object> result = new HashMap<>(changes);
        for (String key : KEYS) {
            boolean changed = changes.containsKey(key);
            Object value = changed ? changes.get(key) : current.get(key);
            if (value == null) continue;
            if (!(value instanceof String)) throw new IllegalStateException("连接信息无效");
            String text = (String)value;
            if (changed) result.put(key, text.isEmpty() ? text : codec.seal(key + "\u0000" + text));
            else if (!text.isEmpty() && !text.startsWith(SecretEnvelope.PREFIX)) result.put(key, codec.seal(key + "\u0000" + text));
        }
        return result;
    }
}
