package cn.yilu.rayneopaseo;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Authenticated encryption; the caller keeps the key in Android Keystore. */
final class SecretEnvelope {
    static final String PREFIX = "rnp-secret-v1:";
    private static final byte[] AAD = PREFIX.getBytes(StandardCharsets.UTF_8);
    private final SecretKey key;
    SecretEnvelope(SecretKey key) { if (key == null) throw new IllegalArgumentException(); this.key = key; }
    String seal(String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(AAD);
            byte[] iv = cipher.getIV(), encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            if (iv.length != 12) throw new IllegalStateException();
            byte[] bytes = Arrays.copyOf(iv, iv.length + encrypted.length); System.arraycopy(encrypted, 0, bytes, iv.length, encrypted.length);
            return PREFIX + Base64.getEncoder().encodeToString(bytes);
        } catch (Exception failure) { throw new IllegalStateException("无法保护连接信息", failure); }
    }
    String open(String value) {
        try {
            if (value == null || !value.startsWith(PREFIX)) throw new IllegalArgumentException();
            byte[] bytes = Base64.getDecoder().decode(value.substring(PREFIX.length()));
            if (bytes.length < 28) throw new IllegalArgumentException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 0, 12)); cipher.updateAAD(AAD);
            return new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8);
        } catch (Exception failure) { throw new IllegalStateException("无法读取受保护的连接信息", failure); }
    }
}
