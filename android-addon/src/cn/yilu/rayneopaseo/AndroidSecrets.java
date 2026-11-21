package cn.yilu.rayneopaseo;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.Key;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** The encryption key is held by the phone's Android Keystore. */
final class AndroidSecrets {
    private static final String ALIAS = "rayneo_paseo_connection_v1";
    private AndroidSecrets() {}
    static synchronized SecretEnvelope envelope() {
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            Key key = store.getKey(ALIAS, null);
            if (key != null && !(key instanceof SecretKey)) throw new IllegalStateException();
            if (key == null) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                key = generator.generateKey();
            }
            return new SecretEnvelope((SecretKey)key);
        } catch (Exception failure) { throw new IllegalStateException("无法打开手机安全存储", failure); }
    }
}
