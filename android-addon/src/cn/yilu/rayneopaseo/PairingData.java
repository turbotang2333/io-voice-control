package cn.yilu.rayneopaseo;

import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/** Validated incoming connection settings. Existing preferences change only after an explicit confirmation. */
final class PairingData {
    final String computerLabel;
    final Map<String, ConnectionProfiles.Profile> profiles;
    private PairingData(String label, Map<String, ConnectionProfiles.Profile> profiles) {
        this.computerLabel = label; this.profiles = Collections.unmodifiableMap(profiles);
    }
    static void validateTransport(int version, String type, String fingerprint, PairingCode source) {
        if (source == null) throw invalid();
        if (source.certificateSha256.isEmpty()) {
            if (version != 1 || type != null || fingerprint != null) throw invalid();
        } else if (version != 2 || !"tls-passthrough-v1".equals(type) || !source.certificateSha256.equals(fingerprint)) throw invalid();
    }
    static PairingData parse(String label, Map<String, ? extends Map<String, ?>> values, PairingCode source) {
        if (label == null || label.trim().isEmpty() || label.codePointCount(0, label.length()) > 60 || label.matches("(?s).*[\\p{Cc}\\p{Cf}].*")
            || source == null || values == null || values.isEmpty() || values.size() > 2) throw invalid();
        Map<String, ConnectionProfiles.Profile> result = new LinkedHashMap<>();
        for (String backend : new String[]{"paseo", "codex"}) {
            if (!values.containsKey(backend)) continue;
            Map<String, ?> raw = values.get(backend);
            if (raw == null || raw.size() != 3 || !(raw.get("endpoint") instanceof String) || !(raw.get("token") instanceof String)
                || !(raw.get("port") instanceof Number)) throw invalid();
            String endpoint = (String)raw.get("endpoint"), token = (String)raw.get("token");
            Number port = (Number)raw.get("port");
            if (!token.matches("[a-f0-9]{64}") || port.intValue() != port.doubleValue()) throw invalid();
            URL url = BridgeEndpoint.resolve(endpoint, port.intValue());
            if (BridgeEndpoint.useLocalCertificate(url) || !url.getHost().equalsIgnoreCase(source.claimUrl.getHost())
                || effectivePort(url) != effectivePort(source.claimUrl)) throw invalid();
            result.put(backend, new ConnectionProfiles.Profile(endpoint, port.intValue(), token, source.certificateSha256));
        }
        if (result.size() != values.size()) throw invalid();
        if (result.size() == 2 && result.get("paseo").token.equals(result.get("codex").token)) throw invalid();
        return new PairingData(label.trim(), result);
    }
    private static int effectivePort(URL url) { return url.getPort() < 0 ? 443 : url.getPort(); }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("配对信息不完整或与二维码不匹配，尚未保存，请在电脑重新生成二维码"); }
    Map<String, Object> changes(Map<String, ?> previous, String selected, int draftChars, boolean busy) {
        ConnectionProfiles.Profile paseo = profiles.containsKey("paseo") ? profiles.get("paseo") : new ConnectionProfiles.Profile("", 7468, "");
        ConnectionProfiles.Profile codex = profiles.containsKey("codex") ? profiles.get("codex") : new ConnectionProfiles.Profile("", 17469, "");
        return ConnectionProfiles.replacePairing(previous, selected, paseo, codex, draftChars, busy);
    }
}
