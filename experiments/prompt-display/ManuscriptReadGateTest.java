package cn.yilu.rayneopaseo;

public final class ManuscriptReadGateTest {
    private static int checks;
    private static void check(boolean condition) { checks++; if (!condition) throw new AssertionError("check " + checks); }
    public static void main(String[] args) {
        ManuscriptReadGate gate = new ManuscriptReadGate(1000);
        check(!gate.shouldStop(25999));
        check(gate.shouldStop(26000));
        check(!gate.takePause(2000));
        check(gate.fileConfirmed(2000));
        check(!gate.fileConfirmed(2100));
        check(!gate.shouldStop(30000)); // No display ACK is needed to keep a confirmed file open.
        check(!gate.takePause(5499));
        check(gate.takePause(5500));
        check(!gate.takePause(5501));
        check(!gate.shouldStop(60999));
        check(gate.shouldStop(61000));
        gate.close();
        check(gate.shouldStop(6000));
        check(!gate.fileConfirmed(6000));
        check(!gate.takePause(7000));
        ManuscriptReadGate expired = new ManuscriptReadGate(1000);
        check(!expired.fileConfirmed(26000));
        check(!expired.takePause(27000));
        check(expired.shouldStop(999));
        ManuscriptReadGate updating = new ManuscriptReadGate(0);
        check(!updating.fileUpdated(100)); // A refresh cannot replace the initial confirmation.
        check(updating.fileConfirmed(200));
        check(updating.takePause(3700));
        check(updating.fileUpdated(14000));
        check(!updating.takePause(17499));
        check(updating.takePause(17500));
        check(!updating.takePause(17501));
        check(!updating.fileUpdated(60000)); // Updating never extends the absolute deadline.
        updating.close();
        check(!updating.fileUpdated(20000));
        ManuscriptReadGate scrolling = new ManuscriptReadGate(1000, 18000);
        check(scrolling.fileConfirmed(2000));
        check(!scrolling.takePause(19999));
        check(scrolling.takePause(20000));
        System.out.println(checks + " manuscript read lifecycle checks passed");
    }
}
