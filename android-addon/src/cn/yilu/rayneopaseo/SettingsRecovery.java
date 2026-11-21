package cn.yilu.rayneopaseo;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONObject;

/** USB maintenance mailbox lives in this app's scoped external files directory. */
final class SettingsRecovery {
    private static volatile boolean paused;
    static boolean paused() { return paused; }
    private SettingsRecovery() {}
    private static byte[] read(File file, int max) throws IOException {
        if (file.length() < 1 || file.length() > max) throw new IOException("Invalid recovery file size");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = in.read(buffer)) != -1) { out.write(buffer, 0, count); if (out.size() > max) throw new IOException("Recovery file too large"); }
        }
        return out.toByteArray();
    }
    private static void atomic(AtomicFile file, byte[] bytes) {
        FileOutputStream out = null;
        try {
            out = file.startWrite(); out.write(bytes); out.getFD().sync(); file.finishWrite(out); out = null;
            if (!Arrays.equals(bytes, file.readFully())) throw new IOException("Recovery write verification failed");
        }
        catch (IOException failure) { if (out != null) file.failWrite(out); throw new IllegalStateException("Recovery file write failed"); }
    }
    private static String hash(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder out = new StringBuilder();
        for (byte value : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return out.toString();
    }
    private static RecoveryTransaction.Store store(Context context) {
        final AtomicFile journal = new AtomicFile(new File(context.getFilesDir(), "paseo-settings-recovery.journal"));
        return new RecoveryTransaction.Store() {
            public Map<String, Map<String, Object>> read() {
                Map<String, Map<String, Object>> groups = new LinkedHashMap<>();
                for (String name : SettingsSnapshot.NAMES) {
                    Map<String, ?> raw = context.getSharedPreferences(name, Context.MODE_PRIVATE).getAll();
                    groups.put(name, name.equals(SettingsSnapshot.NAMES[0]) ? ConnectionSecrets.read(raw, AndroidSecrets.envelope()) : new HashMap<String, Object>(raw));
                }
                return groups;
            }
            @SuppressWarnings("unchecked")
            public boolean replace(String name, Map<String, Object> values) {
                if (!Arrays.asList(SettingsSnapshot.NAMES).contains(name)) throw new IllegalArgumentException("Invalid namespace");
                Map<String, Object> protectedValues = name.equals(SettingsSnapshot.NAMES[0])
                    ? ConnectionSecrets.protectChanges(Collections.<String, Object>emptyMap(), values, AndroidSecrets.envelope()) : values;
                SharedPreferences.Editor editor = context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear();
                for (Map.Entry<String, Object> entry : protectedValues.entrySet()) {
                    String key = entry.getKey(); Object value = entry.getValue();
                    if (value instanceof String) editor.putString(key, (String)value);
                    else if (value instanceof Integer) editor.putInt(key, (Integer)value);
                    else if (value instanceof Long) editor.putLong(key, (Long)value);
                    else if (value instanceof Boolean) editor.putBoolean(key, (Boolean)value);
                    else if (value instanceof Float) editor.putFloat(key, (Float)value);
                    else if (value instanceof Set) editor.putStringSet(key, (Set<String>)value);
                    else throw new IllegalArgumentException("Invalid preference type");
                }
                return editor.commit();
            }
            public byte[] journal() {
                try { return RecoveryJournal.open(journal.readFully(), AndroidSecrets.envelope()); }
                catch (FileNotFoundException missing) { return null; }
                catch (IOException failure) { throw new IllegalStateException("Cannot read restore journal"); }
            }
            public void saveJournal(byte[] bytes) { atomic(journal, RecoveryJournal.seal(bytes, AndroidSecrets.envelope())); }
            public void clearJournal() { journal.delete(); if (journal() != null) throw new IllegalStateException("Cannot remove restore journal"); }
        };
    }
    static boolean handle(Context context, int draftChars, boolean busy) {
        RecoveryTransaction.Store store = store(context);
        try {
            if (store.journal() != null) {
                paused = true;
                if (draftChars > 0 || busy) return true;
                RecoveryTransaction.recover(store); paused = false;
            }
        } catch (RuntimeException failure) { paused = true; return true; }
        File directory = context.getExternalFilesDir(null); if (directory == null) return false;
        File mailbox = new File(directory, "paseo-recovery"), requestFile = new File(mailbox, "request.json");
        if (!requestFile.isFile()) return false;
        JSONObject response = new JSONObject(); String nonce = "";
        try {
            JSONObject request = new JSONObject(new String(read(requestFile, 1600000), java.nio.charset.StandardCharsets.UTF_8));
            // Consume before acting. A failed result transfer never repeats a restore.
            if (!requestFile.delete()) throw new IOException("Cannot consume maintenance request");
            nonce = request.getString("nonce");
            long now = System.currentTimeMillis(), expires = request.getLong("expiresAt");
            if (!nonce.matches("[a-f0-9]{64}") || expires < now || expires > now + 300000L) throw new IllegalArgumentException("Invalid maintenance request");
            response.put("nonce", nonce);
            if (draftChars > 0 || busy) { response.put("ok", false); response.put("code", "BUSY"); }
            else {
                String action = request.getString("action");
                if (!Arrays.asList("backup", "verify", "restore").contains(action)) throw new IllegalArgumentException("Invalid maintenance action");
                byte[] key = Base64.decode(request.getString("key"), Base64.NO_WRAP);
                if (key.length != 32) throw new IllegalArgumentException("Invalid archive key");
                paused = true;
                Map<String, Map<String, Object>> snapshot;
                if ("backup".equals(action)) {
                    snapshot = store.read(); SettingsSnapshot.validate(snapshot);
                    byte[] plain = SettingsSnapshot.encode(snapshot), archive = RecoveryArchive.encrypt(plain, key);
                    response.put("archive", Base64.encodeToString(archive, Base64.NO_WRAP));
                    response.put("snapshotSha256", hash(plain)); response.put("archiveSha256", hash(archive));
                } else {
                    byte[] archive = Base64.decode(request.getString("archive"), Base64.NO_WRAP);
                    snapshot = SettingsSnapshot.decode(RecoveryArchive.decrypt(archive, key)); SettingsSnapshot.validate(snapshot);
                    if ("restore".equals(action)) RecoveryTransaction.restore(store, snapshot, request.getLong("epochFloor"), draftChars, busy);
                    Map<String, Map<String, Object>> expected = SettingsSnapshot.decode(SettingsSnapshot.encode(snapshot)), current = store.read();
                    Object wantedOwner = expected.get(SettingsSnapshot.NAMES[0]).get("navigation_owner");
                    response.put("identityMatches", wantedOwner.equals(current.get(SettingsSnapshot.NAMES[0]).get("navigation_owner")));
                    expected.get(SettingsSnapshot.NAMES[0]).remove("navigation_epoch"); current.get(SettingsSnapshot.NAMES[0]).remove("navigation_epoch");
                    response.put("matchesCurrent", expected.equals(current));
                }
                JSONObject counts = new JSONObject(); for (String name : SettingsSnapshot.NAMES) counts.put(name, snapshot.get(name).size());
                response.put("preferenceCounts", counts); response.put("ok", true);
            }
        } catch (Exception failure) {
            try { paused = store.journal() != null; } catch (RuntimeException ignored) { paused = true; }
            try { response = new JSONObject(); response.put("nonce", nonce); response.put("ok", false); response.put("code", "RECOVERY_REJECTED"); }
            catch (Exception ignored) { return true; }
        }
        try { atomic(new AtomicFile(new File(mailbox, "response.json")), response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        catch (RuntimeException ignored) { /* Desktop times out and never retries an uncertain restore. */ }
        return true;
    }
}
