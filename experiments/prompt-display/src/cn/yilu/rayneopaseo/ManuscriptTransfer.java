package cn.yilu.rayneopaseo;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.BitSet;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Wire facts cross-checked with OpenRayneo 7f2fc0d main.swift and the pinned APK.
 * Owns one synthetic file task; never synchronizes or deletes the manuscript catalog. */
final class ManuscriptTransfer {
    private final String task, document;
    private final byte[] content;
    private final int characters;
    private final BitSet queued = new BitSet();
    private boolean completed;
    ManuscriptTransfer(String task, String document, String text) {
        if (task == null || task.isEmpty() || document == null || document.isEmpty()
            || text == null || text.isEmpty()) throw new IllegalArgumentException("empty transfer");
        this.task = task; this.document = document;
        content = text.getBytes(StandardCharsets.UTF_8); characters = text.length();
        if (content.length > 8192) throw new IllegalArgumentException("probe file too large");
    }
    int byteCount() { return content.length; }
    int characterCount() { return characters; }
    int queuedBytes() { return queued.cardinality(); }
    boolean completed() { return completed; }
    String checksum() { return fnv(content); }
    byte[] content() { return content.clone(); }
    byte[] descriptor() {
        return Proto.bytes(1, Proto.join(Proto.text(1, task), Proto.text(2, document),
            Proto.number(3, content.length), Proto.text(4, md5(content)), Proto.number(5, 17)));
    }
    static final class Reply {
        final byte[] packet;
        final boolean completed;
        private final ManuscriptTransfer owner;
        private final int offset, length;
        private Reply(ManuscriptTransfer owner, byte[] packet, int offset, int length, boolean completed) {
            this.owner = owner; this.packet = packet; this.offset = offset; this.length = length; this.completed = completed;
        }
    }
    Reply receive(byte[] packet) {
        if (completed) return null;
        Proto outer = Proto.read(packet);
        byte[] request = outer.bytes(3), result = outer.bytes(5);
        if (request != null) {
            Proto input = Proto.read(request);
            if (!task.equals(input.text(1))) return null;
            long offset = input.number(3), requested = input.number(4);
            if (offset < 0 || offset >= content.length || requested <= 0)
                throw new IllegalArgumentException("invalid chunk range");
            int length = (int) Math.min(requested, content.length - offset);
            byte[] body = Proto.join(Proto.text(1, task), Proto.number(2, input.number(2)),
                Proto.number(3, offset), Proto.number(4, length),
                Proto.bytes(5, Arrays.copyOfRange(content, (int) offset, (int) offset + length)));
            return new Reply(this, Proto.bytes(4, body), (int) offset, length, false);
        }
        if (result != null) {
            Proto input = Proto.read(result);
            if (!task.equals(input.text(1))) return null;
            if (input.number(2) != 0 || queued.cardinality() != content.length)
                throw new IllegalArgumentException("transfer not confirmed");
            completed = true;
            return new Reply(this, null, 0, 0, true);
        }
        return null;
    }
    void queued(Reply reply) {
        if (reply == null || reply.owner != this || reply.completed || completed)
            throw new IllegalArgumentException("wrong transfer reply");
        queued.set(reply.offset, reply.offset + reply.length);
    }
    static String fnv(byte[] bytes) {
        int hash = 0x811c9dc5;
        for (byte value : bytes) hash = (hash ^ (value & 255)) * 0x01000193;
        return String.format(Locale.ROOT, "%08x", hash);
    }
    static String md5(byte[] bytes) {
        try {
            byte[] hash = MessageDigest.getInstance("MD5").digest(bytes);
            StringBuilder result = new StringBuilder();
            for (byte value : hash) result.append(String.format(Locale.ROOT, "%02x", value & 255));
            return result.toString();
        } catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    /** Minimal bounded protobuf codec, without dependencies or a raw Bluetooth writer. */
    static final class Proto {
        private final Map<Integer, Object> fields = new HashMap<>();
        static Proto read(byte[] packet) {
            if (packet == null || packet.length > 65531) throw new IllegalArgumentException("invalid packet");
            Proto message = new Proto(); int[] position = {0};
            while (position[0] < packet.length) {
                long tag = varint(packet, position);
                int field = (int) (tag >>> 3), wire = (int) (tag & 7);
                if (field < 1 || tag >>> 3 > 0x1fffffff || message.fields.containsKey(field))
                    throw new IllegalArgumentException("invalid or duplicate field");
                if (wire == 0) message.fields.put(field, varint(packet, position));
                else if (wire == 2) {
                    long length = varint(packet, position);
                    if (length < 0 || length > packet.length - position[0]) throw new IllegalArgumentException("truncated field");
                    int end = position[0] + (int) length;
                    message.fields.put(field, Arrays.copyOfRange(packet, position[0], end)); position[0] = end;
                } else if (wire == 1 || wire == 5) {
                    int length = wire == 1 ? 8 : 4;
                    if (length > packet.length - position[0]) throw new IllegalArgumentException("truncated field");
                    message.fields.put(field, new Object()); position[0] += length;
                } else throw new IllegalArgumentException("unsupported wire type");
            }
            return message;
        }
        long number(int field) {
            Object value = fields.get(field);
            if (value == null) return 0;
            if (!(value instanceof Long)) throw new IllegalArgumentException("wrong number field");
            return (Long) value;
        }
        byte[] bytes(int field) {
            Object value = fields.get(field);
            if (value == null) return null;
            if (!(value instanceof byte[])) throw new IllegalArgumentException("wrong bytes field");
            return (byte[]) value;
        }
        String text(int field) { byte[] value = bytes(field); return value == null ? "" : new String(value, StandardCharsets.UTF_8); }
        private static long varint(byte[] data, int[] position) {
            long value = 0;
            for (int n = 0; n < 10; n++) {
                if (position[0] >= data.length) throw new IllegalArgumentException("truncated varint");
                int next = data[position[0]++] & 255;
                if (n == 9 && (next & 254) != 0) throw new IllegalArgumentException("overflowing varint");
                value |= (long) (next & 127) << (7 * n);
                if ((next & 128) == 0) return value;
            }
            throw new IllegalArgumentException("overflowing varint");
        }
        private static byte[] varint(long value) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            do { int next = (int) (value & 127); value >>>= 7; bytes.write(value == 0 ? next : next | 128); } while (value != 0);
            return bytes.toByteArray();
        }
        static byte[] number(int field, long value) { return join(varint(((long) field) << 3), varint(value)); }
        static byte[] text(int field, String text) { return bytes(field, text.getBytes(StandardCharsets.UTF_8)); }
        static byte[] bytes(int field, byte[] bytes) { return join(varint((((long) field) << 3) | 2), varint(bytes.length), bytes); }
        static byte[] join(byte[]... pieces) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            for (byte[] piece : pieces) bytes.write(piece, 0, piece.length);
            return bytes.toByteArray();
        }
    }
}
