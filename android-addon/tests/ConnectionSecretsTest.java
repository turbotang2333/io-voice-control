package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;
import javax.crypto.spec.SecretKeySpec;

public final class ConnectionSecretsTest {
    static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        SecretEnvelope codec = new SecretEnvelope(new SecretKeySpec(new byte[32], "AES"));
        Map<String, Object> original = new HashMap<>();
        original.put("token", "legacy-token"); original.put("connection.paseo.token", "paseo-token");
        original.put("connection.codex.token", "codex-token"); original.put("mode", 3);
        Map<String, Object> changes = new HashMap<>(); changes.put("navigation_epoch", 2L);
        Map<String, Object> encrypted = ConnectionSecrets.protectChanges(original, changes, codec);
        for (String key : new String[]{"token", "connection.paseo.token", "connection.codex.token"}) {
            check(!encrypted.get(key).equals(original.get(key)));
            check(!((String)encrypted.get(key)).contains((String)original.get(key)));
        }
        Map<String, Object> stored = new HashMap<>(original); stored.putAll(encrypted);
        Map<String, Object> readable = ConnectionSecrets.read(stored, codec);
        check(readable.get("token").equals("legacy-token"));
        check(readable.get("connection.paseo.token").equals("paseo-token"));
        check(readable.get("mode").equals(3));
        Map<String, Object> edit = new HashMap<>(); edit.put("token", "replacement"); edit.put("connection.codex.token", null);
        Map<String, Object> next = ConnectionSecrets.protectChanges(stored, edit, codec);
        Map<String, Object> replaced = new HashMap<>(stored); replaced.putAll(next);
        check(ConnectionSecrets.read(replaced, codec).get("token").equals("replacement"));
        check(next.containsKey("connection.codex.token") && next.get("connection.codex.token") == null);
        check(original.get("token").equals("legacy-token"));
        Map<String, Object> swapped = new HashMap<>(stored);
        swapped.put("connection.paseo.token", stored.get("connection.codex.token"));
        try { ConnectionSecrets.read(swapped, codec); throw new AssertionError(); }
        catch (IllegalStateException expected) { }
        String protectedValue = codec.seal("private-token");
        byte[] wrongKey = new byte[32]; wrongKey[0] = 1;
        try { new SecretEnvelope(new SecretKeySpec(wrongKey, "AES")).open(protectedValue); throw new AssertionError(); }
        catch (IllegalStateException expected) { }
        try { codec.open(protectedValue.substring(0, protectedValue.length() - 3) + "!!!"); throw new AssertionError(); }
        catch (IllegalStateException expected) { }
        final Map<String, Object> preferences = new HashMap<>(original);
        NavigationSession.Store store = new NavigationSession.Store() {
            public Map<String, ?> read() { return ConnectionSecrets.read(preferences, codec); }
            public boolean commit(Map<String, Object> values) {
                Map<String, Object> protectedValues = ConnectionSecrets.protectChanges(preferences, values, codec);
                for (Map.Entry<String, Object> e : protectedValues.entrySet()) {
                    if (e.getValue() == null) preferences.remove(e.getKey()); else preferences.put(e.getKey(), e.getValue());
                }
                return true;
            }
        };
        NavigationSession session = new NavigationSession(); session.initialize(store);
        check(session.configuration().get("token").equals("legacy-token"));
        check(!preferences.get("token").equals("legacy-token"));
        Map<String, Object> update = new HashMap<>(); update.put("token", "new-token"); session.advance(store, update);
        check(session.configuration().get("token").equals("new-token"));
        check(!preferences.get("token").equals("new-token"));
        System.out.println("connection secret checks passed");
    }
}
