package cn.yilu.rayneopaseo;

public final class ReplyReadingGateTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
    public static void main(String[] args) {
        ReplyReadingGate gate = new ReplyReadingGate();
        check(gate.claim(0, "idle", "测试问题", "完整回答") < 0);
        gate.arm(100);
        check(gate.armed(100));
        check(gate.claim(200, "idle", "当前模式", "Paseo") < 0);
        check(gate.armed(200));
        check(gate.claim(200, "idle", "测试问题", "") < 0);
        long token = gate.claim(300, "idle", "测试问题", "完整回答😀");
        check(token >= 0);
        check(gate.pending(token));
        check(!gate.armed(300));
        check(gate.claim(400, "idle", "测试问题", "重复回答") < 0);
        gate.cancel();
        check(!gate.pending(token));
        gate.arm(500);
        long next = gate.claim(600, "idle", "测试问题", "另一篇回答");
        check(next != token && gate.pending(next));
        gate.arm(700);
        check(!gate.pending(next));
        gate.cancel();
        check(!gate.armed(800));
        gate.arm(1000);
        check(gate.claim(301000, "idle", "测试问题", "过期回答") < 0);
        check(!gate.armed(301000));
        gate.arm(400000);
        check(gate.claim(399999, "idle", "测试问题", "时钟倒退") < 0);
        gate.arm(500000);
        StringBuilder large = new StringBuilder();
        for (int i = 0; i < 3000; i++) large.append('中');
        check(gate.claim(500001, "idle", "测试问题", large.toString()) < 0);
        check(!gate.armed(500001)); // Oversized replies stay in the assistant, without truncation.
        gate.arm(600000);
        for (String outcome : new String[]{"error", "unknown", "timeout", "permission", "control", "local", "", null}) {
            check(gate.claim(600001, outcome, "测试问题", "错误或状态提示") < 0);
            check(gate.armed(600001)); // A rejected request cannot consume the next valid answer.
        }
        check(gate.claim(600002, "idle", "测试问题", "正常完成的回答") >= 0);
        System.out.println(checks + " reply reading gate checks passed");
    }
}
