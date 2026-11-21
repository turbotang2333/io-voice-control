package cn.yilu.rayneopaseo;

public final class MikaTaskStateTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static void equal(String a, String b) { if (!a.equals(b)) throw new AssertionError(a + " != " + b); }
    public static void main(String[] args) {
        MikaTaskState s = new MikaTaskState();
        equal(s.nextAction("打开微信"), "start");
        s.begin("7d55133d-882e-4975-8358-aef08d843b44");
        equal(s.nextAction("再看一下"), "unknown");
        equal(s.update("running", "phone_tap", "", ""), "正在启动。");
        check(s.isProgress());
        equal(s.update("running", "正在打开微信", "", ""), "");
        equal(s.nextAction("只看第一条"), "steer");
        equal(s.update("waiting_for_answer", "", "选择哪个会话？", ""), "选择哪个会话？");
        check(!s.isProgress());
        equal(s.update("waiting_for_answer", "", "选择哪个会话？", ""), "");
        equal(s.nextAction("第一个"), "answer");
        equal(s.update("waiting_on_phone", "", "", ""), "请在手机上处理。");
        equal(s.nextAction("第一个"), "on_phone");
        equal(s.update("done", "", "", "已完成。"), "已完成。");
        check(!s.isProgress());
        equal(s.nextAction("下一件事"), "start");
        s.begin("924d34fd-2641-4858-838c-59675dab14f6");
        equal(s.update("queued", "", "", ""), "正在排队。");
        equal(s.nextAction("新任务"), "busy");
        equal(s.nextAction("取消手机任务"), "cancel");
        equal(s.update("failed", "", "", ""), "任务未完成，请在手机上查看。 ".trim());
        s.begin("c39ff695-08b9-460a-844d-ce6e3cbb0320");
        equal(s.update("failed", "", "", "未进入结算，也没有付款。"), "未进入结算，也没有付款。");
        s.begin("0637e277-c067-4647-8fd4-6261ad8ec7a2");
        equal(s.update("running", "", "", ""), "正在启动。");
        equal(s.update("running", "phone_tap", "", ""), "");
        equal(s.update("paused", "phone_type", "", ""), "任务已暂停，请在手机上查看。");
        System.out.println("Mika task state checks passed");
    }
}
