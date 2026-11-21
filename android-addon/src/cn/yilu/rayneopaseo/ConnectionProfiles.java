package cn.yilu.rayneopaseo;

import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;

/** Immutable request settings and atomic updates for the two independent backends. */
final class ConnectionProfiles {
    static final String PASEO = "paseo", CODEX = "codex", MIKA = "mika";
    static final String OFFICIAL = "official";
    static final class Profile {
        final String endpoint, token, certificateSha256;
        final int port;
        Profile(String endpoint, int port, String token) {
            this(endpoint, port, token, "");
        }
        Profile(String endpoint, int port, String token, String certificateSha256) {
            this.endpoint = endpoint == null ? "" : endpoint.trim();
            this.port = port;
            this.token = token == null ? "" : token.trim();
            if (certificateSha256 == null || (!certificateSha256.isEmpty() && !certificateSha256.matches("[a-f0-9]{64}")))
                throw new IllegalArgumentException("电脑身份信息无效，请重新扫码配对");
            this.certificateSha256 = certificateSha256;
        }
    }
    private ConnectionProfiles() {}
    static String label(String backend) { if (MIKA.equals(backend)) return "Mika"; requireBackend(backend); return CODEX.equals(backend) ? "Codex" : "Paseo"; }
    private static void requireBackend(String backend) {
        if (!PASEO.equals(backend) && !CODEX.equals(backend)) throw new IllegalArgumentException("未知连接模式，未保存");
    }
    static String panelMode(Map<String, ?> prefs) {
        Object value = prefs.get("mode");
        return value instanceof Number && ((Number)value).intValue() >= 2 ? active(prefs) : OFFICIAL;
    }
    static Map<String, Object> switchMode(Map<String, ?> prefs, String selected, int draftChars, boolean busy) {
        String reason = blocked(draftChars, busy);
        if (!reason.isEmpty()) throw new IllegalStateException(reason);
        if (OFFICIAL.equals(selected)) {
            Map<String, Object> changes = new HashMap<>(); changes.put("mode", 0); return changes;
        }
        if (MIKA.equals(selected)) {
            if (!Boolean.TRUE.equals(prefs.get("mika.configured"))) throw new IllegalArgumentException("请先配置 Mika 本机连接");
            Map<String, Object> changes = new HashMap<>(); changes.put("connection.backend", MIKA); changes.put("mode", 3); return changes;
        }
        requireBackend(selected);
        return update(prefs, selected, load(prefs, PASEO), load(prefs, CODEX), 3, draftChars, busy);
    }
    static List<InteractionPreferences.Command> commandsFor(String backend) {
        requireBackend(backend);
        List<InteractionPreferences.Command> result = new ArrayList<>();
        for (InteractionPreferences.Command command : InteractionPreferences.commands()) {
            result.add(command);
        }
        return result;
    }
    private static String text(Map<String, ?> prefs, String key, String fallback) {
        Object value = prefs.get(key);
        return value instanceof String ? (String)value : fallback;
    }
    private static int port(Map<String, ?> prefs, String key, int fallback) {
        Object value = prefs.get(key);
        return value instanceof Integer ? (Integer)value : fallback;
    }
    static String active(Map<String, ?> prefs) {
        String saved = text(prefs, "connection.backend", "");
        if (!saved.isEmpty()) { if (!MIKA.equals(saved)) requireBackend(saved); return saved; }
        String endpoint = text(prefs, "endpoint", "").trim();
        try {
            String path = new URI(endpoint).getPath();
            if (path != null && path.replaceFirst("/+$", "").endsWith("/rayneo-codex")) return CODEX;
        } catch (Exception ignored) { /* Validation reports an invalid legacy address when saving. */ }
        return endpoint.isEmpty() && port(prefs, "port", 7468) == 17469 ? CODEX : PASEO;
    }
    static Profile load(Map<String, ?> prefs, String backend) {
        requireBackend(backend);
        String prefix = "connection." + backend + ".";
        if (prefs.containsKey(prefix + "port")) {
            return new Profile(text(prefs, prefix + "endpoint", ""), port(prefs, prefix + "port", -1), text(prefs, prefix + "token", ""), text(prefs, prefix + "certificateSha256", ""));
        }
        if (!prefs.containsKey("connection.backend") && backend.equals(active(prefs))) {
            return new Profile(text(prefs, "endpoint", ""), port(prefs, "port", 7467), text(prefs, "token", ""));
        }
        return new Profile("", CODEX.equals(backend) ? 17469 : 7468, "");
    }
    static String blocked(int draftChars, boolean busy) {
        if (busy) return "正在发送或等待回复，请完成后再切换或保存设置";
        if (draftChars > 0) return "还有未发送内容，请先确认发送或取消发送，再切换或保存设置";
        return "";
    }
    static Map<String, Object> update(Map<String, ?> prefs, String backend, Profile paseo, Profile codex,
                                      int workflow, int draftChars, boolean busy) {
        String reason = blocked(draftChars, busy);
        if (!reason.isEmpty()) throw new IllegalStateException(reason);
        requireBackend(backend);
        if (workflow < 0 || workflow > 3) throw new IllegalArgumentException("无效对话设置，未保存");
        if (paseo == null) paseo = load(prefs, PASEO);
        if (codex == null) codex = load(prefs, CODEX);
        paseo = retainIdentity(prefs, PASEO, paseo);
        codex = retainIdentity(prefs, CODEX, codex);
        BridgeEndpoint.resolve(paseo.endpoint, paseo.port);
        BridgeEndpoint.resolve(codex.endpoint, codex.port);
        Profile selected = CODEX.equals(backend) ? codex : paseo;
        if (workflow >= 2 && selected.token.isEmpty()) throw new IllegalArgumentException("请先填写所选模式的接入令牌，未保存");
        Map<String, Object> values = new HashMap<>();
        put(values, PASEO, paseo); put(values, CODEX, codex);
        values.put("connection.backend", backend);
        // Keep the active legacy fields compatible with existing builds and rollback.
        values.put("endpoint", selected.endpoint); values.put("port", selected.port); values.put("token", selected.token);
        values.put("mode", workflow);
        return values;
    }
    private static void put(Map<String, Object> values, String backend, Profile profile) {
        String prefix = "connection." + backend + ".";
        values.put(prefix + "endpoint", profile.endpoint); values.put(prefix + "port", profile.port); values.put(prefix + "token", profile.token);
        values.put(prefix + "certificateSha256", profile.certificateSha256);
    }
    static Map<String, Object> replacePairing(Map<String, ?> prefs, String backend, Profile paseo, Profile codex,
                                               int draftChars, boolean busy) {
        String reason = blocked(draftChars, busy);
        if (!reason.isEmpty()) throw new IllegalStateException(reason);
        requireBackend(backend);
        BridgeEndpoint.resolve(paseo.endpoint, paseo.port);
        BridgeEndpoint.resolve(codex.endpoint, codex.port);
        Profile selected = CODEX.equals(backend) ? codex : paseo;
        Map<String, Object> values = new HashMap<>();
        put(values, PASEO, paseo); put(values, CODEX, codex);
        values.put("connection.backend", backend);
        values.put("endpoint", selected.endpoint); values.put("port", selected.port); values.put("token", selected.token);
        Object oldMode = prefs.get("mode");
        values.put("mode", OFFICIAL.equals(panelMode(prefs)) ? (oldMode instanceof Number ? ((Number)oldMode).intValue() : 0) : 3);
        return values;
    }
    private static Profile retainIdentity(Map<String, ?> prefs, String backend, Profile replacement) {
        Profile previous = load(prefs, backend);
        if (previous.certificateSha256.isEmpty() || !replacement.certificateSha256.isEmpty()) return replacement;
        if (!previous.endpoint.equals(replacement.endpoint) || previous.port != replacement.port)
            throw new IllegalArgumentException("加密连接的地址已变化，请重新扫码确认电脑身份");
        return new Profile(replacement.endpoint, replacement.port, replacement.token, previous.certificateSha256);
    }
}
