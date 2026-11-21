package cn.yilu.rayneopaseo;

public final class ReaderWakeHandoffGateTest {
    private static int checks;
    private static void check(boolean value) {
        checks++;
        if (!value) throw new AssertionError("handoff check " + checks);
    }
    public static void main(String[] args) {
        ReaderWakeHandoffGate gate = new ReaderWakeHandoffGate("device", "document", 100);
        check(!gate.takeWake("device", 1, 101)); // A wake before the stop reply cannot complete this handoff.
        check(!gate.takeStop("other", "document", 6, 2, 1, 102));
        check(!gate.takeStop("device", "other", 6, 2, 1, 103));
        check(!gate.takeStop("device", "document", 4, 2, 1, 104));
        check(!gate.takeStop("device", "document", 6, 1, 1, 105));
        check(gate.takeStop("device", "document", 6, 2, 1, 106));
        check(!gate.takeStop("device", "document", 6, 2, 1, 107));
        check(!gate.takeWake("other", 1, 108));
        check(!gate.takeWake("device", 3, 109));
        check(gate.takeWake("device", 1, 110));
        check(!gate.takeWake("device", 1, 111));
        check(gate.closed());

        gate = new ReaderWakeHandoffGate("device", "document", 0);
        check(!gate.takeStop("device", "document", 6, 2, 2, 1));
        check(gate.closed()); // An explicit rejection must not launch the assistant.
        gate = new ReaderWakeHandoffGate("device", "document", 0);
        check(!gate.takeStop("device", "document", 6, 2, 1, 8000));
        check(gate.closed());
        gate = new ReaderWakeHandoffGate("device", "document", 0);
        check(gate.takeStop("device", "document", 6, 2, 1, 7999));
        check(!gate.expired(15998));
        check(gate.expired(15999));
        check(!gate.takeWake("device", 1, 16000));

        gate = new ReaderWakeHandoffGate("device", null, 50); // Isolated startup from the normal screen.
        check(gate.takeWake("device", 1, 51));
        gate = new ReaderWakeHandoffGate("device", null, 50);
        gate.close();
        check(!gate.takeWake("device", 1, 51));
        check(gate.closed());
        System.out.println(checks + " reader wake handoff checks passed");
    }
}
