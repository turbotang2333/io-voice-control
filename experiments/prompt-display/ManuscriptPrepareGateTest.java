package cn.yilu.rayneopaseo;

public final class ManuscriptPrepareGateTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    public static void main(String[] args) {
        ManuscriptPrepareGate gate = new ManuscriptPrepareGate();
        check(!gate.takeTransfer(1, 1));
        check(!gate.takeTransfer(2, 7));
        check(!gate.takeTransfer(2, 0));
        check(gate.takeTransfer(2, 1));
        check(!gate.takeTransfer(2, 1)); // Duplicate prepare replies cannot register another file.
        check(!gate.takeTransfer(2, 7)); // Later non-success replies cannot restart or stop reading.
        gate.close();
        check(!gate.takeTransfer(2, 1));
        ManuscriptPrepareGate cancelled = new ManuscriptPrepareGate();
        cancelled.close();
        check(!cancelled.takeTransfer(2, 1));
        System.out.println(checks + " manuscript prepare ordering checks passed");
    }
}
