package cn.yilu.rayneopaseo;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.spec.SecretKeySpec;

public final class RecoveryJournalTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) {
        Map<String, Map<String, Object>> groups = new LinkedHashMap<>();
        for (String name : SettingsSnapshot.NAMES) groups.put(name, new HashMap<String, Object>());
        groups.get(SettingsSnapshot.NAMES[0]).put("token", "private-test-token");
        byte[] plain = SettingsSnapshot.encode(groups);
        SecretEnvelope codec = new SecretEnvelope(new SecretKeySpec(new byte[32], "AES"));
        byte[] sealed = RecoveryJournal.seal(plain, codec);
        check(!new String(sealed, StandardCharsets.UTF_8).contains("private-test-token"));
        check(Arrays.equals(plain, RecoveryJournal.open(sealed, codec)));
        check(Arrays.equals(plain, RecoveryJournal.open(plain, codec)));
        sealed[sealed.length - 1] ^= 1;
        try { RecoveryJournal.open(sealed, codec); throw new AssertionError(); } catch (IllegalStateException expected) { }
        try { RecoveryJournal.open(new byte[]{1, 2, 3}, codec); throw new AssertionError(); } catch (IllegalStateException expected) { }
        System.out.println("recovery journal checks passed");
    }
}
