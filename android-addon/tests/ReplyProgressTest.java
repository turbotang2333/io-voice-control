package cn.yilu.rayneopaseo;

public final class ReplyProgressTest {
    private static void equal(String actual, String expected) {
        if (!expected.equals(actual)) throw new AssertionError("expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        ReplyProgress codex = ReplyProgress.forBackend("codex", false, false, InteractionPreferences.defaults());
        equal(codex.state("working"), "（回复中）");
        equal(codex.state("working"), "");
        equal(codex.state("tool"), "（调用工具）");
        equal(codex.state("tool"), "");
        equal(codex.state("permission"), "（等待授权，请在原客户端处理）");
        equal(codex.state("permission"), "");
        equal(codex.finish("idle"), "（本轮完成）");
        equal(ReplyProgress.forBackend("unknown", false, false, InteractionPreferences.defaults()).state("working"), "");
        ReplyProgress reply = new ReplyProgress(true, false);
        equal(reply.state("sending"), ""); // Transport acceptance is not Agent acknowledgement.
        equal(reply.state("working"), "（回复中）");
        equal(reply.state("working"), "");
        equal(reply.state("tool"), "（调用工具）");
        equal(reply.state("tool"), "");
        equal(reply.state("working"), "");
        equal(reply.finish("idle"), "（本轮完成）");
        equal(reply.finish("idle"), "");
        equal(reply.state("tool"), "");
        ReplyProgress search = new ReplyProgress(true, true);
        equal(search.state("sending"), "");
        equal(search.state("searching"), "（正在查找）");
        equal(search.state("searching"), "");
        equal(search.state("working"), "");
        equal(search.state("tool"), "");
        equal(search.state("permission"), "");
        equal(search.finish("control"), "");
        equal(new ReplyProgress(true, true).finish("idle"), "");
        for (String outcome : new String[]{"permission", "error", "timeout", "unknown", "control", "local"}) {
            ReplyProgress failed = new ReplyProgress(true, false);
            equal(failed.state("working"), "（回复中）");
            equal(failed.finish(outcome), "");
            equal(failed.state("tool"), "");
        }
        ReplyProgress unsupported = new ReplyProgress(false, false);
        equal(unsupported.state("working"), "");
        equal(unsupported.state("tool"), "");
        equal(unsupported.finish("idle"), "");
        ReplyProgress next = new ReplyProgress(true, false);
        equal(next.state("working"), "（回复中）");
        equal(next.state("searching"), "");
        java.util.Map<String, String> changed = new java.util.HashMap<>();
        changed.put("text.working", "（正在回答）");
        ReplyProgress custom = new ReplyProgress(true, false, InteractionPreferences.defaults().withChanges(changed));
        equal(custom.state("working"), "（正在回答）");
        ReplyProgress creation = new ReplyProgress(true, false, true, InteractionPreferences.defaults());
        equal(creation.state("working"), "");
        equal(creation.state("creating"), "（正在创建）");
        equal(creation.state("creating"), "");
        equal(creation.state("tool"), "");
        equal(creation.finish("idle"), "");
        System.out.println("reply progress checks passed");
    }
}
