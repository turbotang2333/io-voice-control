package cn.yilu.rayneopaseo;

import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;
import java.util.HashMap;
import java.util.Map;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.HybridBinarizer;

public final class PairingTest {
    static void check(boolean result) { if (!result) throw new AssertionError(); }
    static void rejected(Runnable action) { try { action.run(); } catch (IllegalArgumentException | IllegalStateException expected) { return; } throw new AssertionError("unsafe pairing was accepted"); }
    public static void main(String[] args) throws Exception {
        BufferedImage image = ImageIO.read(new File(args[0]));
        int w = image.getWidth(), h = image.getHeight();
        String text = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, h, image.getRGB(0, 0, w, h, null, 0, w))))).getText();
        PairingCode code = PairingCode.parse(text);
        check(code.claimUrl.toString().equals("https://example.test/trial/paseo/v1/pairing/claim"));
        check(code.code.equals(new String(new char[43]).replace('\0', 'x')));
        for (String bad : new String[]{"http://example.test/pair#rayneo_pair=" + code.code, "https://127.0.0.1/pair#rayneo_pair=" + code.code,
            "https://example.test/pair?leak=x#rayneo_pair=" + code.code, "https://user:pass@example.test/pair#rayneo_pair=" + code.code,
            "https://example.test/not-pair#rayneo_pair=" + code.code, "https://example.test/pair#rayneo_pair=short"}) rejected(() -> PairingCode.parse(bad));
        Map<String, Map<String, Object>> profiles = new HashMap<>();
        Map<String, Object> profile = new HashMap<>(); profile.put("endpoint", "https://example.test/trial/paseo"); profile.put("port", 7468); profile.put("token", new String(new char[64]).replace('\0', 'a')); profiles.put("paseo", profile);
        PairingData data = PairingData.parse("测试电脑", profiles, code);
        Map<String, Object> old = new HashMap<>(); old.put("custom_prompt", "保留");
        Map<String, Object> changes = data.changes(old, "paseo", 0, false);
        check(changes.get("connection.paseo.endpoint").equals(profile.get("endpoint")));
        check(changes.get("connection.backend").equals("paseo")); check(old.size() == 1);
        old.put("connection.backend", "codex"); old.put("mode", 3);
        old.put("connection.codex.endpoint", "https://old.example.test/codex"); old.put("connection.codex.port", 17469);
        old.put("connection.codex.token", "old-token"); old.put("connection.codex.certificateSha256", new String(new char[64]).replace('\0', 'b'));
        Map<String, Object> switched = data.changes(old, "codex", 0, false);
        check(switched.get("connection.backend").equals("codex"));
        check(switched.get("connection.codex.token").equals(""));
        check(switched.get("connection.codex.endpoint").equals(""));
        check(switched.get("connection.codex.certificateSha256").equals(""));
        check(switched.get("token").equals(""));
        rejected(() -> data.changes(old, "paseo", 1, false)); rejected(() -> data.changes(old, "paseo", 0, true));
        profile.put("endpoint", "https://another.example.test/paseo"); rejected(() -> PairingData.parse("电脑", profiles, code));
        profile.put("endpoint", "https://example.test/trial/paseo"); profile.put("token", "invalid"); rejected(() -> PairingData.parse("电脑", profiles, code));
        System.out.println("pairing checks passed");
    }
}
