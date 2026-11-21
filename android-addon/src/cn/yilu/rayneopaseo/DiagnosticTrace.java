package cn.yilu.rayneopaseo;

import java.io.File;
import java.io.FileOutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/** Short-lived, opt-in counters only. Never accepts recognition text or identifiers. */
final class DiagnosticTrace {
    private static final long WINDOW_MS = 15 * 60 * 1000L;
    private static final long RETENTION_MS = 14L * 24 * 60 * 60 * 1000;
    private static final int FILE_LIMIT = 262144;
    private static final String NUMBER = "-?[0-9]{1,19}";
    private static final String BOOL = "(?:true|false)";
    private static final Pattern SAFE = Pattern.compile(("(?:"
        + "native input begin previousDraftChars=N wasActive=B|"
        + "native input resumed afterSecondaryWake=B draftChars=N|"
        + "native input armed localOnly=B limitMs=N|"
        + "native input heartbeat audioPackets=N lastAudioAgeMs=N draftChars=N|"
        + "native (?:input|background) asr final chars=N draftChars=N inputFinished=B|"
        + "native input responseComplete draftChars=N inputFinished=B|"
        + "native input audioStart count=N elapsedMs=N|"
        + "native (?:input|background asr) error code=N|"
        + "native input late error ignored while waiting code=N|"
        + "native input stopped reason=(?:cancelled|timeout|idle_timeout|error|finished|background_asr_error|background_asr_start_failed|asr_callback_failed|resume_failed|display_failed|replied) audioStarts=N|"
        + "native input idle config bosBeforeMs=N bosAfterMs=N eosMs=N endMs=N|"
        + "native background asr started page=native localOnly=B|"
        + "native command (?:submitted|display finalized) chars=N|"
        + "native conversation ready nextRound=N|"
        + "native transport audioPackets=N elapsedMs=N|"
        + "native transport control type=N rc=N audioPackets=N elapsedMs=N|"
        + "native input unrelated (?:asr|nlp) ignored|"
        + "native input official reply held|"
        + "native background display failed|"
        + "bridge (?:http=N|elapsedMs=N|request failed)"
        + ")").replace("=N", "=" + NUMBER).replace("=B", "=" + BOOL));
    private static File root;
    private static boolean scheduled;

    static synchronized void configure(File directory) {
        root = directory;
        prune(System.currentTimeMillis());
        if (!scheduled && directory != null) {
            scheduled = true;
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread thread = new Thread(r, "paseo-diagnostic-retention");
                thread.setDaemon(true);
                return thread;
            }).scheduleWithFixedDelay(() -> prune(System.currentTimeMillis()), 1, 1, TimeUnit.HOURS);
        }
    }

    static synchronized void prune(long now) {
        if (root == null) return;
        File folder = new File(root, "paseo-diagnostics");
        for (String name : new String[]{"events.log", "events.previous.log"}) {
            File file = new File(folder, name);
            if (!file.isFile() || file.length() > FILE_LIMIT) continue;
            try {
                StringBuilder keep = new StringBuilder();
                boolean changed = false;
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        int space = line.indexOf(' ');
                        long timestamp = 0;
                        try { if (space > 0) timestamp = Long.parseLong(line.substring(0, space)); }
                        catch (NumberFormatException ignored) { }
                        if (timestamp > 0 && timestamp >= now - RETENTION_MS && timestamp <= now) keep.append(line).append('\n');
                        else changed = true;
                    }
                }
                if (!changed) continue;
                if (keep.length() == 0) { file.delete(); continue; }
                File temp = new File(folder, name + ".retention.tmp");
                try (FileOutputStream stream = new FileOutputStream(temp)) { stream.write(keep.toString().getBytes(StandardCharsets.UTF_8)); }
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) { /* A failed cleanup must not affect the assistant. */ }
        }
    }

    static synchronized void append(String metadata, long now) {
        // Full-match allowlist rejects even otherwise safe events with extra text.
        if (root == null || metadata == null || metadata.length() > 256 || !SAFE.matcher(metadata).matches()) return;
        try {
            File flag = new File(root, "paseo-diagnostics.enabled");
            long age = now - flag.lastModified();
            if (!flag.isFile() || age < 0 || age > WINDOW_MS) return;
            File folder = new File(root, "paseo-diagnostics");
            if (!folder.isDirectory() && !folder.mkdirs()) return;
            File log = new File(folder, "events.log");
            byte[] line = (now + " " + metadata + "\n").getBytes(StandardCharsets.UTF_8);
            if (log.length() + line.length > FILE_LIMIT) {
                File previous = new File(folder, "events.previous.log");
                if (previous.exists() && !previous.delete()) return;
                if (!log.renameTo(previous)) return;
            }
            try (FileOutputStream stream = new FileOutputStream(log, true)) { stream.write(line); }
        } catch (Exception ignored) {
            // Diagnostics must not stop recognition, display or submission.
        }
    }
}
