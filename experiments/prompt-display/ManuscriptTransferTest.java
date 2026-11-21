package cn.yilu.rayneopaseo;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class ManuscriptTransferTest {
    private static int checks;
    private static void check(boolean condition) { checks++; if (!condition) throw new AssertionError("check " + checks); }
    private static void rejects(Runnable action) {
        checks++; try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("expected rejection " + checks);
    }
    private static byte[] hex(String value) {
        byte[] bytes = new byte[value.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }
    public static void main(String[] args) {
        ManuscriptTransfer file = new ManuscriptTransfer("t", "d", "甲🙂乙\n");
        check(file.byteCount() == 11 && file.characterCount() == 5);
        check("5d41402abc4b2a76b9719d911017c592".equals(ManuscriptTransfer.md5("hello".getBytes(StandardCharsets.UTF_8))));
        check("4f9f2cab".equals(ManuscriptTransfer.fnv("hello".getBytes(StandardCharsets.UTF_8))));
        // Independent wire fixtures: zero offset/chunk/result are omitted by protobuf.
        check(file.receive(hex("1a050a0178200b")) == null); // another task
        ManuscriptTransfer.Reply reply = file.receive(hex("1a050a0174200b"));
        check(reply != null && !reply.completed);
        check(!file.completed());
        rejects(() -> file.receive(hex("2a030a0174"))); // not locally queued yet
        ManuscriptTransfer.Proto response = ManuscriptTransfer.Proto.read(reply.packet);
        ManuscriptTransfer.Proto chunk = ManuscriptTransfer.Proto.read(response.bytes(4));
        check("t".equals(chunk.text(1)) && chunk.number(2) == 0 && chunk.number(3) == 0);
        check(chunk.number(4) == 11);
        check(Arrays.equals(chunk.bytes(5), "甲🙂乙\n".getBytes(StandardCharsets.UTF_8)));
        file.queued(reply);
        check(file.queuedBytes() == 11);
        check(file.receive(hex("2a030a0178")) == null);
        rejects(() -> file.receive(hex("2a050a01741001"))); // nonzero transfer result
        check(file.receive(hex("2a030a0174")).completed);
        check(file.completed());
        check(file.receive(hex("1a050a0174200b")) == null);

        ManuscriptTransfer sparse = new ManuscriptTransfer("t", "d", "abcdefghijk");
        ManuscriptTransfer.Reply tail = sparse.receive(hex("1a070a017418052006"));
        sparse.queued(tail); sparse.queued(tail);
        check(sparse.queuedBytes() == 6);
        rejects(() -> sparse.receive(hex("2a030a0174")));
        ManuscriptTransfer.Reply head = sparse.receive(hex("1a050a01742005"));
        sparse.queued(head);
        check(sparse.receive(hex("2a030a0174")).completed);

        ManuscriptTransfer invalid = new ManuscriptTransfer("t", "d", "abc");
        rejects(() -> invalid.receive(hex("1a070a017418042001"))); // outside file
        rejects(() -> invalid.receive(hex("1a030a0174"))); // zero byte request
        rejects(() -> ManuscriptTransfer.Proto.read(hex("1a050a01"))); // truncated field
        rejects(() -> ManuscriptTransfer.Proto.read(hex("088080808080808080808000"))); // overflowing varint
        rejects(() -> ManuscriptTransfer.Proto.read(hex("08010802"))); // duplicate field
        ManuscriptTransfer.Proto descriptor = ManuscriptTransfer.Proto.read(
            ManuscriptTransfer.Proto.read(invalid.descriptor()).bytes(1));
        check("t".equals(descriptor.text(1)) && "d".equals(descriptor.text(2)));
        check(descriptor.number(3) == 3 && descriptor.number(5) == 17);
        check("900150983cd24fb0d6963f7d28e17f72".equals(descriptor.text(4)));
        System.out.println(checks + " manuscript transfer checks passed");
    }
}
