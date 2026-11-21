package cn.yilu.rayneopaseo;

public final class ContinuousDraftTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }

    public static void main(String[] args) {
        ContinuousDraft draft = new ContinuousDraft();
        check(draft.accept("苹", false).kind == ContinuousDraft.Kind.NONE);
        check(draft.accept("苹果", true).kind == ContinuousDraft.Kind.ADDED);
        check(draft.accept("香蕉", true).kind == ContinuousDraft.Kind.ADDED);
        check("苹果，香蕉".equals(draft.snapshot()));
        ContinuousDraft.Result send = draft.accept("确认发送。", true);
        check(send.kind == ContinuousDraft.Kind.SEND);
        check("苹果，香蕉".equals(send.text));
        check(draft.snapshot().isEmpty());
        check(draft.accept("确认发送", true).kind == ContinuousDraft.Kind.NONE);

        check(draft.accept("请解释确认发送是什么意思", true).kind == ContinuousDraft.Kind.ADDED);
        check(draft.accept("取消发送", true).kind == ContinuousDraft.Kind.CANCEL);
        check(draft.snapshot().isEmpty());
        check(draft.accept("新的问题", true).kind == ContinuousDraft.Kind.ADDED);
        check(draft.accept("确认发送", false).kind == ContinuousDraft.Kind.NONE);
        check("新的问题".equals(draft.snapshot()));
        check(draft.accept("确认发送", true).kind == ContinuousDraft.Kind.SEND);
        // Retired commands are ordinary words; only the new cancel clears them.
        check(draft.accept("现在发送", true).kind == ContinuousDraft.Kind.ADDED);
        check(draft.accept("取消输入", true).kind == ContinuousDraft.Kind.ADDED);
        check("现在发送，取消输入".equals(draft.snapshot()));
        check(draft.accept("取消发送。", true).kind == ContinuousDraft.Kind.CANCEL);
        check(draft.snapshot().isEmpty());
    }
}
