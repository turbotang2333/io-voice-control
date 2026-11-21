package cn.yilu.rayneopaseo;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Old interrupted transactions remain recoverable; new journals are encrypted. */
final class RecoveryJournal {
    private RecoveryJournal() {}
    static byte[] seal(byte[] bytes, SecretEnvelope codec) {
        SettingsSnapshot.decode(bytes);
        return codec.seal(Base64.getEncoder().encodeToString(bytes)).getBytes(StandardCharsets.UTF_8);
    }
    static byte[] open(byte[] bytes, SecretEnvelope codec) {
        try {
            if (bytes == null || bytes.length > 2 * SettingsSnapshot.MAX_BYTES) throw new IllegalArgumentException();
            String text = new String(bytes, StandardCharsets.UTF_8);
            byte[] plain = text.startsWith(SecretEnvelope.PREFIX) ? Base64.getDecoder().decode(codec.open(text)) : bytes;
            SettingsSnapshot.decode(plain);
            return plain;
        } catch (RuntimeException failure) { throw new IllegalStateException("无法读取设置恢复记录", failure); }
    }
}
