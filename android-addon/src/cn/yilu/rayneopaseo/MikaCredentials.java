package cn.yilu.rayneopaseo;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** The token stays in app-private encrypted storage, separate from exported settings. */
final class MikaCredentials {
    private static final String ALIAS = "rayneo_paseo_mika_v1";
    private final SharedPreferences prefs;
    MikaCredentials(Context context) { prefs = context.getSharedPreferences("rayneo_paseo_mika_private", Context.MODE_PRIVATE); }
    private SecretKey key(boolean create) throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        java.security.Key found = keys.getKey(ALIAS, null);
        if (found instanceof SecretKey) return (SecretKey)found;
        if (!create) throw new IllegalStateException("Mika credential unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    void save(int port, String token) throws Exception {
        if (port < 1024 || port > 65535 || token == null || !token.matches("[A-Za-z0-9_-]{32,256}")) throw new IllegalArgumentException();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String data = Base64.encodeToString(cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putInt("port", port).putString("iv", iv).putString("cipher", data).commit()) throw new IllegalStateException("无法保存 Mika 连接");
    }
    int port() { return prefs.getInt("port", 8765); }
    String token() throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP);
        byte[] data = Base64.decode(prefs.getString("cipher", ""), Base64.NO_WRAP);
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(data), StandardCharsets.UTF_8);
    }
}
