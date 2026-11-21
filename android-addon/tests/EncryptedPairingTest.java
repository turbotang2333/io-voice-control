package cn.yilu.rayneopaseo;

import java.util.HashMap;
import java.util.Map;

public final class EncryptedPairingTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static void rejects(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("unsafe encrypted pairing accepted");
    }
    public static void main(String[] args) {
        String proof = new String(new char[43]).replace('\0', 'x');
        String pin = new String(new char[64]).replace('\0', 'c');
        String uri = "https://relay.example.test:24443/paseo/pair#rayneo_pair=" + proof;
        PairingCode code = PairingCode.parse(uri + "&tls_sha256=" + pin);
        check(code.certificateSha256.equals(pin));
        check(code.code.equals(proof));
        PairingData.validateTransport(2, "tls-passthrough-v1", pin, code);
        rejects(() -> PairingData.validateTransport(1, null, null, code));
        rejects(() -> PairingData.validateTransport(2, "tls-passthrough-v1", new String(new char[64]).replace('\0', 'a'), code));
        rejects(() -> PairingData.validateTransport(2, "https", pin, code));
        rejects(() -> PairingCode.parse(uri + "&tls_sha256=" + pin + "&tls_sha256=" + pin));
        rejects(() -> PairingCode.parse(uri + "&tls_sha256=bad"));
        rejects(() -> PairingCode.parse(uri + "&tls_sha256=" + pin + "&unknown=true"));
        Map<String, Map<String, Object>> profiles = new HashMap<>();
        Map<String, Object> profile = new HashMap<>();
        profile.put("endpoint", "https://relay.example.test:24443/paseo");
        profile.put("port", 7468); profile.put("token", new String(new char[64]).replace('\0', 'a'));
        profiles.put("paseo", profile);
        PairingData data = PairingData.parse("电脑", profiles, code);
        check(data.profiles.get("paseo").certificateSha256.equals(pin));
        Map<String, Object> saved = new HashMap<>(data.changes(new HashMap<>(), "paseo", 0, false));
        check(ConnectionProfiles.load(saved, "paseo").certificateSha256.equals(pin));
        final Map<String, Object> configured = new HashMap<>(saved);
        rejects(() -> ConnectionProfiles.update(configured, "paseo", new ConnectionProfiles.Profile("https://different.example.test/paseo", 7468, "new-token"), null, 3, 0, false));
        // Editing a token in the existing manual form must not erase the paired desktop identity.
        ConnectionProfiles.Profile edited = new ConnectionProfiles.Profile("https://relay.example.test:24443/paseo", 7468, "new-token");
        saved.putAll(ConnectionProfiles.update(saved, "paseo", edited, null, 3, 0, false));
        check(ConnectionProfiles.load(saved, "paseo").certificateSha256.equals(pin));
        check(PairingCode.parse(uri).certificateSha256.isEmpty());
        PairingCode ipv4 = PairingCode.parse("https://203.0.113.10:24443/paseo/pair#rayneo_pair=" + proof + "&tls_sha256=" + pin);
        profile.put("endpoint", "https://203.0.113.10:24443/paseo");
        check(PairingData.parse("电脑", profiles, ipv4).profiles.get("paseo").certificateSha256.equals(pin));
        profile.put("endpoint", "https://203.0.113.11:24443/paseo");
        rejects(() -> PairingData.parse("电脑", profiles, ipv4));
        profile.put("endpoint", "https://relay.example.test:24444/paseo");
        rejects(() -> PairingData.parse("电脑", profiles, code));
        System.out.println("encrypted pairing checks passed");
    }
}
