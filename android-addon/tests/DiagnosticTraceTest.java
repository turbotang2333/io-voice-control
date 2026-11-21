package cn.yilu.rayneopaseo;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public final class DiagnosticTraceTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]); root.mkdirs();
        File flag = new File(root, "paseo-diagnostics.enabled");
        File folder = new File(root, "paseo-diagnostics");
        File log = new File(folder, "events.log");
        long now = System.currentTimeMillis();
        DiagnosticTrace.configure(root);
        DiagnosticTrace.append("native input armed localOnly=false limitMs=240000", now);
        check(!folder.exists());
        Files.write(flag.toPath(), new byte[0]); check(flag.setLastModified(now));
        DiagnosticTrace.append("native input armed localOnly=false limitMs=240000", now);
        DiagnosticTrace.append("native input asr final chars=12 draftChars=40 inputFinished=false", now + 1);
        DiagnosticTrace.append("native input begin previousDraftChars=40 wasActive=true", now + 2);
        DiagnosticTrace.append("native input resumed afterSecondaryWake=true draftChars=40", now + 2);
        DiagnosticTrace.append("native background asr error code=-1", now + 3);
        DiagnosticTrace.append("native command submitted chars=40", now + 4);
        DiagnosticTrace.append("native input idle config bosBeforeMs=10000 bosAfterMs=210000 eosMs=1000 endMs=1000", now + 4);
        String content = new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8);
        check(content.contains("draftChars=40") && content.contains("previousDraftChars=40"));
        check(content.contains("bosBeforeMs=10000"));
        check(content.contains("resumed afterSecondaryWake=true draftChars=40"));
        long size = log.length();
        for (String bad : new String[]{"private spoken words", "Bearer secret", "native command submitted chars=40 text=secret",
                "native input error code=1\nprivate words", "native input error code=secret"}) DiagnosticTrace.append(bad, now + 5);
        check(log.length() == size);
        DiagnosticTrace.append("native input error code=2", now + 15 * 60 * 1000 + 1);
        check(log.length() == size);
        for (int i = 0; i < 7000; i++) DiagnosticTrace.append("native input heartbeat audioPackets=200 lastAudioAgeMs=20 draftChars=300", now + 10);
        check(log.length() <= 262144);
        File previous = new File(folder, "events.previous.log");
        check(previous.isFile() && previous.length() <= 262144);
        check(folder.list().length == 2);
        Files.delete(flag.toPath()); size = log.length();
        DiagnosticTrace.append("native input error code=3", now + 20);
        check(log.length() == size);
        long retention = 14L * 24 * 60 * 60 * 1000;
        Files.write(log.toPath(), ((now - retention - 1) + " native input error code=1\n" + (now - 1000) + " native input error code=2\n").getBytes(StandardCharsets.UTF_8));
        Files.write(previous.toPath(), ((now - retention - 1) + " native input error code=3\n").getBytes(StandardCharsets.UTF_8));
        DiagnosticTrace.prune(now);
        content = new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8);
        check(!content.contains("code=1") && content.contains("code=2"));
        check(!previous.exists());
        File broken = new File(root, "broken"); broken.mkdirs();
        File brokenFlag = new File(broken, "paseo-diagnostics.enabled");
        Files.write(brokenFlag.toPath(), new byte[0]); brokenFlag.setLastModified(now);
        new File(broken, "paseo-diagnostics/events.log").mkdirs();
        DiagnosticTrace.configure(broken);
        DiagnosticTrace.append("native input error code=4", now);
        System.out.println("Diagnostic trace checks passed");
    }
}
