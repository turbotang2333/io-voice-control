package cn.yilu.rayneopaseo;

public final class ManuscriptCompletionGateTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    public static void main(String[] args) {
        ManuscriptCompletionGate gate = new ManuscriptCompletionGate("own", "glasses");
        check(!gate.consume(100, "other", "own", 4, 1, 1, true));
        check(!gate.consume(100, "glasses", "foreign", 4, 1, 1, true));
        check(!gate.consume(100, "glasses", "own", 4, 1, 1, false));
        check(!gate.consume(100, "glasses", "own", 4, 2, 1, true));
        check(!gate.consume(100, "glasses", "own", 6, 1, 1, true));
        check(!gate.consume(100, "glasses", "own", 4, 1, 2, true));
        check(!gate.canAck(100));
        check(gate.consume(200, "glasses", "own", 4, 1, 1, true));
        check(gate.canAck(200));
        check(gate.consume(201, "glasses", "own", 4, 1, 1, true)); // Idempotent reply for a retry.
        check(gate.canAck(15199));
        check(!gate.canAck(15200));
        check(!gate.consume(15200, "glasses", "own", 4, 1, 1, true));
        check(!gate.canAck(199));
        ManuscriptCompletionGate cancelled = new ManuscriptCompletionGate("own", "glasses");
        check(cancelled.consume(100, "glasses", "own", 4, 1, 1, true));
        cancelled.close();
        check(!cancelled.canAck(101));
        check(!cancelled.consume(101, "glasses", "own", 4, 1, 1, true));
        System.out.println(checks + " manuscript completion ownership checks passed");
    }
}
