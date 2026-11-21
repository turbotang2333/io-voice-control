package cn.yilu.rayneopaseo;

public final class MikaTaskCoordinatorTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    private static final class Store implements MikaTaskCoordinator.Store {
        String id = ""; boolean fail;
        public String read() { return id; }
        public boolean save(String value) { if (fail) return false; id = value; return true; }
    }
    private static final class Remote implements MikaTaskCoordinator.Remote {
        int starts, reads, answers, steers, cancels;
        String lastConversation;
        boolean loseReceipt, missing, unavailable;
        String preparation = ""; int preparations;
        public String prepare() { preparations++; return preparation; }
        String status = "running", text = "正在执行。";
        public MikaTaskCoordinator.Snapshot start(String goal, String id, String conversation) throws Exception {
            lastConversation = conversation;
            starts++; if (loseReceipt) throw new Exception();
            return new MikaTaskCoordinator.Snapshot(id, status, text, "", "", "mika-chat-1");
        }
        public MikaTaskCoordinator.Snapshot read(String id) throws Exception { reads++; if (missing) throw new MikaTaskCoordinator.TaskNotFound(); if (unavailable) throw new Exception(); return new MikaTaskCoordinator.Snapshot(id, status, text, "", "", "mika-chat-1"); }
        public void send(String action, String id, String message) {
            if ("answer".equals(action)) answers++;
            if ("steer".equals(action)) steers++;
            if ("cancel".equals(action)) cancels++;
        }
    }
    public static void main(String[] args) throws Exception {
        String id = "c1d58c91-2d07-44f1-92d7-238175deed7d";
        Store store = new Store(); Remote remote = new Remote();
        MikaTaskCoordinator c = new MikaTaskCoordinator(store, remote, () -> id);
        remote.preparation = "请在手机上检查解锁设置，任务未发送。";
        check(c.send("打开微信").contains("未发送")); check(remote.starts == 0 && store.id.isEmpty());
        remote.preparation = "";
        store.fail = true;
        check(c.send("打开微信").contains("未发送")); check(remote.starts == 0);
        store.fail = false; remote.loseReceipt = true;
        check(c.send("打开微信").contains("不要重复发送")); check(store.id.equals(id) && remote.starts == 1);
        check(c.send("打开微信").contains("不要重复发送")); check(remote.starts == 1);
        MikaTaskCoordinator restored = new MikaTaskCoordinator(store, remote, () -> id);
        check(restored.refresh().equals("正在启动。")); check(remote.reads == 1);
        remote.status = "waiting_for_answer"; remote.text = "";
        check(restored.refresh().contains("问题"));
        restored.send("第一个"); check(remote.answers == 1 && remote.starts == 1);
        remote.status = "waiting_on_phone"; restored.refresh();
        check(restored.send("确认").contains("手机上处理")); check(remote.answers == 1);
        restored.send("取消手机任务"); check(remote.cancels == 1);
        remote.unavailable = true;
        try { restored.refresh(); throw new AssertionError(); } catch (Exception expected) { check(store.id.equals(id)); }
        remote.unavailable = false; remote.missing = true;
        check(restored.refresh().contains("没有找到"));
        check(store.id.isEmpty() && restored.taskId().isEmpty() && remote.starts == 1);
        remote.missing = false;
        restored.send("打开时钟"); check(remote.starts == 2);
        MikaTaskCoordinator conversation = new MikaTaskCoordinator(new Store(), remote, () -> id);
        remote.status = "done"; remote.loseReceipt = false;
        conversation.send("第一句话", "glasses-session-1"); check(remote.lastConversation == null);
        conversation.send("接着说", "glasses-session-1"); check("mika-chat-1".equals(remote.lastConversation));
        conversation.send("新对话", "glasses-session-2"); check(remote.lastConversation == null);
        remote.status = "running";
        MikaTaskCoordinator active = new MikaTaskCoordinator(new Store(), remote, () -> id);
        active.send("运行任务", "first-session");
        int previousSteers = remote.steers;
        check(active.send("新的问题", "next-session").contains("任务"));
        check(remote.steers == previousSteers);
        int previousCancels = remote.cancels;
        active.send("取消手机任务", "next-session"); check(remote.cancels == previousCancels + 1);
        System.out.println("Mika coordinator checks passed");
    }
}
