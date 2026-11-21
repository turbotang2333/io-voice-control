package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;

public final class ConnectionProfilesTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static void rejects(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException | IllegalStateException expected) { return; }
        throw new AssertionError("unsafe update accepted");
    }
    public static void main(String[] args) {
        Map<String, Object> prefs = new HashMap<>();
        prefs.put("endpoint", "https://gateway.example/rayneo-paseo");
        prefs.put("port", 7468); prefs.put("token", "paseo-test-token"); prefs.put("mode", 3);
        check("paseo".equals(ConnectionProfiles.active(prefs)));
        ConnectionProfiles.Profile paseo = ConnectionProfiles.load(prefs, "paseo");
        ConnectionProfiles.Profile blankCodex = ConnectionProfiles.load(prefs, "codex");
        check("paseo-test-token".equals(paseo.token));
        check(blankCodex.token.isEmpty() && blankCodex.endpoint.isEmpty() && blankCodex.port == 17469);
        ConnectionProfiles.Profile codex = new ConnectionProfiles.Profile("https://gateway.example/rayneo-codex", 17469, "codex-test-token");
        prefs.putAll(ConnectionProfiles.update(prefs, "codex", paseo, codex, 3, 0, false));
        check("codex".equals(ConnectionProfiles.active(prefs)));
        check("codex-test-token".equals(prefs.get("token")));
        check(Integer.valueOf(17469).equals(prefs.get("port")));
        // Reload from persisted values, then switch back: neither backend may inherit the other's secret.
        prefs = new HashMap<>(prefs);
        check("paseo-test-token".equals(ConnectionProfiles.load(prefs, "paseo").token));
        prefs.putAll(ConnectionProfiles.update(prefs, "paseo", ConnectionProfiles.load(prefs, "paseo"),
            ConnectionProfiles.load(prefs, "codex"), 3, 0, false));
        check("paseo-test-token".equals(prefs.get("token")));
        check("codex-test-token".equals(ConnectionProfiles.load(prefs, "codex").token));
        check("https://gateway.example/rayneo-paseo".equals(paseo.endpoint));
        // The visible tab is the actual mode; official mode preserves both profiles.
        check("paseo".equals(ConnectionProfiles.panelMode(prefs)));
        Map<String, Object> official = new HashMap<>(prefs);
        official.putAll(ConnectionProfiles.switchMode(prefs, "official", 0, false));
        check("official".equals(ConnectionProfiles.panelMode(official)));
        check("paseo-test-token".equals(ConnectionProfiles.load(official, "paseo").token));
        check("codex-test-token".equals(ConnectionProfiles.load(official, "codex").token));
        official.putAll(ConnectionProfiles.switchMode(official, "codex", 0, false));
        check("codex".equals(ConnectionProfiles.panelMode(official)));
        check(Integer.valueOf(3).equals(official.get("mode")));
        check("codex-test-token".equals(official.get("token")));
        Map<String, Object> local = new HashMap<>(prefs);
        rejects(() -> ConnectionProfiles.switchMode(local, "mika", 0, false));
        local.put("mika.configured", true);
        local.putAll(ConnectionProfiles.switchMode(local, "mika", 0, false));
        check("mika".equals(ConnectionProfiles.panelMode(local)));
        check("paseo-test-token".equals(ConnectionProfiles.load(local, "paseo").token));
        check("codex-test-token".equals(ConnectionProfiles.load(local, "codex").token));
        local.putAll(ConnectionProfiles.switchMode(local, "codex", 0, false));
        check("codex".equals(ConnectionProfiles.panelMode(local)));
        rejects(() -> ConnectionProfiles.switchMode(prefsForGuard(), "official", 9, false));
        rejects(() -> ConnectionProfiles.switchMode(prefsForGuard(), "official", 0, true));
        rejects(() -> ConnectionProfiles.switchMode(new HashMap<>(), "codex", 0, false));
        check(ConnectionProfiles.commandsFor("paseo").stream().anyMatch(c -> c.id.equals("search")));
        check(ConnectionProfiles.commandsFor("codex").stream().anyMatch(c -> c.id.equals("search")));
        check(ConnectionProfiles.commandsFor("codex").stream().anyMatch(c -> c.id.equals("create")));
        // Unsafe changes return no updates, keeping both the original preferences and draft untouched.
        final Map<String, Object> saved = new HashMap<>(prefs);
        rejects(() -> ConnectionProfiles.update(saved, "codex", paseo, codex, 3, 12, false));
        rejects(() -> ConnectionProfiles.update(saved, "codex", paseo, codex, 3, 0, true));
        rejects(() -> ConnectionProfiles.update(saved, "codex", paseo, blankCodex, 3, 0, false));
        rejects(() -> ConnectionProfiles.update(saved, "other", paseo, codex, 3, 0, false));
        rejects(() -> ConnectionProfiles.update(saved, "paseo", new ConnectionProfiles.Profile("http://unsafe.example", 7468, "x"), codex, 3, 0, false));
        check(saved.equals(prefs));
        // Legacy Codex is inferred from the explicit path, even with an old USB port left over.
        Map<String, Object> oldCodex = new HashMap<>();
        oldCodex.put("endpoint", "https://gateway.example/rayneo-codex/");
        oldCodex.put("port", 7468); oldCodex.put("token", "legacy-codex");
        check("codex".equals(ConnectionProfiles.active(oldCodex)));
        check("legacy-codex".equals(ConnectionProfiles.load(oldCodex, "codex").token));
        check(ConnectionProfiles.load(oldCodex, "paseo").token.isEmpty());
        oldCodex.put("endpoint", ""); oldCodex.put("port", 17469);
        check("codex".equals(ConnectionProfiles.active(oldCodex)));
        // First saving the current mode must allow the other mode to remain unconfigured.
        Map<String, Object> first = ConnectionProfiles.update(prefs, "paseo", paseo, blankCodex, 3, 0, false);
        check("paseo".equals(first.get("connection.backend")));
        TurnGate gate = new TurnGate();
        Object source = new Object();
        check(!gate.pending());
        gate.recognize(source, "a pending question", true, "request");
        check(gate.pending());
        long generation = gate.beginReply(source, "request");
        check(gate.pending());
        gate.complete(generation);
        check(!gate.pending());
        gate.reset();
        check(!gate.pending());
        // A mode query is local only when spoken separately with an empty draft.
        check(VoiceCommand.isModeQuery("请帮我当前模式。"));
        check(!VoiceCommand.isModeQuery("请解释当前模式有什么区别"));
        NativeInputTrial input = new NativeInputTrial();
        input.arm(true);
        check(input.accept(source, "当前模式", true, "mode-query"));
        check(input.inputFinished() && "当前模式".equals(input.question()));
        input.arm(true);
        input.accept(source, "这是未发送内容", true, "draft");
        input.accept(source, "当前模式", true, "inside-draft");
        check(!input.inputFinished());
        check(input.draftLength() == "这是未发送内容，当前模式".length());
        System.out.println("connection profile checks passed");
    }
    private static Map<String, Object> prefsForGuard() {
        Map<String, Object> prefs = new HashMap<>(); prefs.put("mode", 3); return prefs;
    }
}
