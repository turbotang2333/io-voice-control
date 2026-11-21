package cn.yilu.rayneopaseo;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class RecoveryArchive {
    static final byte[] HEADER = "RAYNEO-PASEO-RECOVERY-1\n".getBytes(StandardCharsets.US_ASCII);
    private RecoveryArchive() {}
    static byte[] encrypt(byte[] plain, byte[] key) {
        try {
            if (plain.length > SettingsSnapshot.MAX_BYTES || key.length != 32) throw new IllegalArgumentException();
            byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv)); cipher.updateAAD(HEADER);
            byte[] encrypted = cipher.doFinal(plain), result = new byte[HEADER.length + 12 + encrypted.length];
            System.arraycopy(HEADER, 0, result, 0, HEADER.length); System.arraycopy(iv, 0, result, HEADER.length, 12);
            System.arraycopy(encrypted, 0, result, HEADER.length + 12, encrypted.length); return result;
        } catch (Exception failure) { throw new IllegalArgumentException("Settings encryption failed"); }
    }
    static byte[] decrypt(byte[] archive, byte[] key) {
        try {
            if (key.length != 32 || archive.length < HEADER.length + 28 || archive.length > SettingsSnapshot.MAX_BYTES + HEADER.length + 28
                || !Arrays.equals(HEADER, Arrays.copyOf(archive, HEADER.length))) throw new IllegalArgumentException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, archive, HEADER.length, 12)); cipher.updateAAD(HEADER);
            return cipher.doFinal(archive, HEADER.length + 12, archive.length - HEADER.length - 12);
        } catch (Exception failure) { throw new IllegalArgumentException("Settings archive is invalid or its key does not match"); }
    }
}
