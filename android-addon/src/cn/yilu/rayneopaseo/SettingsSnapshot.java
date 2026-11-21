package cn.yilu.rayneopaseo;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Bounded typed snapshots contain only our three preference namespaces. */
final class SettingsSnapshot {
    static final String[] NAMES = {"rayneo_paseo_probe", "rayneo_paseo_interaction", "rayneo_paseo_shortcuts"};
    static final int MAX_BYTES = 1024 * 1024;
    private static final String MAGIC = "rayneo-paseo-settings-v1";
    private SettingsSnapshot() {}
    private static void text(DataOutputStream out, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 65536) throw new IllegalArgumentException("Setting is too large");
        out.writeInt(bytes.length); out.write(bytes);
    }
    private static String text(DataInputStream in) throws IOException {
        int count = in.readInt();
        if (count < 0 || count > 65536 || count > in.available()) throw new IOException("Invalid setting length");
        byte[] bytes = new byte[count]; in.readFully(bytes);
        return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
    }
    static byte[] encode(Map<String, Map<String, Object>> groups) {
        try {
            if (!groups.keySet().equals(new HashSet<>(Arrays.asList(NAMES)))) throw new IllegalArgumentException("Unexpected settings namespace");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(buffer);
            text(out, MAGIC);
            for (String name : NAMES) {
                Map<String, Object> values = groups.get(name);
                if (values == null || values.size() > 512) throw new IllegalArgumentException("Too many settings");
                text(out, name); out.writeInt(values.size());
                for (Map.Entry<String, Object> entry : new TreeMap<>(values).entrySet()) {
                    if (entry.getKey().isEmpty() || entry.getKey().length() > 256) throw new IllegalArgumentException("Invalid setting key");
                    text(out, entry.getKey()); Object value = entry.getValue();
                    if (value instanceof String) { out.writeByte(1); text(out, (String)value); }
                    else if (value instanceof Integer) { out.writeByte(2); out.writeInt((Integer)value); }
                    else if (value instanceof Long) { out.writeByte(3); out.writeLong((Long)value); }
                    else if (value instanceof Boolean) { out.writeByte(4); out.writeBoolean((Boolean)value); }
                    else if (value instanceof Float) { out.writeByte(5); out.writeFloat((Float)value); }
                    else if (value instanceof Set) {
                        Set<?> set = (Set<?>)value; if (set.size() > 256) throw new IllegalArgumentException("Setting set is too large");
                        TreeSet<String> sorted = new TreeSet<>();
                        for (Object item : set) { if (!(item instanceof String)) throw new IllegalArgumentException("Invalid setting set"); sorted.add((String)item); }
                        out.writeByte(6); out.writeInt(sorted.size()); for (String item : sorted) text(out, item);
                    } else throw new IllegalArgumentException("Unsupported setting type");
                    if (buffer.size() > MAX_BYTES) throw new IllegalArgumentException("Settings snapshot is too large");
                }
            }
            out.flush(); return buffer.toByteArray();
        } catch (IOException failure) { throw new IllegalArgumentException("Invalid settings snapshot"); }
    }
    static Map<String, Map<String, Object>> decode(byte[] bytes) {
        try {
            if (bytes == null || bytes.length > MAX_BYTES) throw new IOException("Invalid snapshot size");
            DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes));
            if (!MAGIC.equals(text(in))) throw new IOException("Invalid snapshot format");
            Map<String, Map<String, Object>> groups = new LinkedHashMap<>();
            for (String name : NAMES) {
                if (!name.equals(text(in))) throw new IOException("Invalid snapshot namespace");
                int count = in.readInt(); if (count < 0 || count > 512) throw new IOException("Invalid entry count");
                Map<String, Object> values = new HashMap<>();
                for (int i = 0; i < count; i++) {
                    String key = text(in); if (key.isEmpty() || key.length() > 256 || values.containsKey(key)) throw new IOException("Invalid key");
                    Object value;
                    switch (in.readUnsignedByte()) {
                        case 1: value = text(in); break;
                        case 2: value = in.readInt(); break;
                        case 3: value = in.readLong(); break;
                        case 4: int flag = in.readUnsignedByte(); if (flag > 1) throw new IOException("Invalid boolean"); value = flag == 1; break;
                        case 5: value = in.readFloat(); break;
                        case 6:
                            int size = in.readInt(); if (size < 0 || size > 256) throw new IOException("Invalid set count");
                            Set<String> set = new HashSet<>(); for (int j = 0; j < size; j++) if (!set.add(text(in))) throw new IOException("Duplicate set value");
                            value = set; break;
                        default: throw new IOException("Invalid setting type");
                    }
                    values.put(key, value);
                }
                groups.put(name, values);
            }
            if (in.available() != 0) throw new IOException("Trailing snapshot data");
            return groups;
        } catch (IOException failure) { throw new IllegalArgumentException("Invalid settings snapshot"); }
    }
    static long epoch(Map<String, Object> values) {
        Object owner = values.get("navigation_owner"), epoch = values.get("navigation_epoch");
        if (!(owner instanceof String) || !((String)owner).matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
            || !(epoch instanceof Long || epoch instanceof Integer) || ((Number)epoch).longValue() < 1
            || ((Number)epoch).longValue() >= 9007199254740989L) throw new IllegalArgumentException("Invalid navigation identity");
        return ((Number)epoch).longValue();
    }
    static void validate(Map<String, Map<String, Object>> groups) {
        encode(groups); Map<String, Object> connection = groups.get(NAMES[0]); epoch(connection);
        Object mode = connection.get("mode"); if (!(mode instanceof Integer)) throw new IllegalArgumentException("Invalid saved mode");
        String active = ConnectionProfiles.active(connection);
        if (ConnectionProfiles.MIKA.equals(active)) {
            if (!Boolean.TRUE.equals(connection.get("mika.configured")) || (Integer)mode < 0 || (Integer)mode > 3)
                throw new IllegalArgumentException("Invalid Mika settings");
            ConnectionProfiles.update(connection, ConnectionProfiles.PASEO, null, null, 0, 0, false);
        } else ConnectionProfiles.update(connection, active, null, null, (Integer)mode, 0, false);
        InteractionPreferences vocabulary = InteractionPreferences.fromStored(groups.get(NAMES[1]));
        ShortcutBindings.fromStored(ShortcutScopes.read(groups.get(NAMES[2]), "paseo"), vocabulary);
        ShortcutBindings.fromStored(ShortcutScopes.read(groups.get(NAMES[2]), "codex"), vocabulary);
    }
}
