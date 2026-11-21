package cn.yilu.rayneopaseo;
import java.util.function.Supplier;
final class MikaTaskCoordinator {
    static final class TaskNotFound extends Exception { }
    interface Store { String read(); boolean save(String value); }
    interface Remote {
        String prepare() throws Exception;
        Snapshot start(String goal, String id, String conversation) throws Exception;
        Snapshot read(String id) throws Exception;
        void send(String action, String id, String message) throws Exception;
    }
    static final class Snapshot {
        final String id, state, progress, question, answer, conversation;
        Snapshot(String i, String s, String p, String q, String a, String c) { id=i; state=s; progress=p; question=q; answer=a; conversation=c; }
    }
    private final Store store;
    private final Remote remote;
    private final Supplier<String> ids;
    private final MikaTaskState state = new MikaTaskState();
    private String glassesSession = "", mikaConversation = "", sessionTask = "";
    MikaTaskCoordinator(Store store, Remote remote, Supplier<String> id) {
        if (store == null || remote == null || id == null) throw new IllegalArgumentException();
        this.store = store; this.remote = remote; this.ids = id;
        String existing = store.read();
        if (existing != null && !existing.isEmpty()) state.begin(existing);
    }
    synchronized String send(String text) throws Exception { return send(text, "legacy"); }
    synchronized String send(String text, String session) throws Exception {
        if (text == null || text.trim().isEmpty()) return "请说出要执行的任务。";
        if (session == null || session.isEmpty()) return "无法确认眼镜对话状态，任务未发送。";
        if (!session.equals(glassesSession)) {
            glassesSession = session; mikaConversation = ""; sessionTask = "";
        }
        String action = state.nextAction(text);
        if (sessionTask.isEmpty() && !"legacy".equals(session) && !"start".equals(action) && !"cancel".equals(action))
            return "上一段对话的手机任务尚未结束，请先在手机处理或说取消手机任务。";
        if ("start".equals(action)) {
            try {
                String problem = remote.prepare();
                if (!problem.isEmpty()) return problem;
            } catch (Exception unavailable) { return "无法确认手机解锁状态，任务未发送。"; }
            String id = ids.get();
            if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
                return "任务未发送，请重试。";
            if (!store.save(id)) return "任务未发送，请检查手机存储。";
            state.begin(id);
            sessionTask = id;
            try { return apply(remote.start(text.trim(), id, mikaConversation.isEmpty() ? null : mikaConversation)); }
            catch (Exception uncertain) { return "任务状态不确定，请先查询，不要重复发送。"; }
        }
        if ("unknown".equals(action)) return "任务状态不确定，请先查询，不要重复发送。";
        if ("on_phone".equals(action)) return "请在手机上处理。";
        if ("busy".equals(action)) return "任务尚未准备好，请稍候。";
        try {
            remote.send(action, state.taskId(), text.trim());
            state.update("starting", "", "", "");
            return "cancel".equals(action) ? "已请求取消，请稍候确认。" : "已收到，请稍候。";
        } catch (Exception uncertain) { return "操作结果不确定，请先查询，不要重复发送。"; }
    }
    synchronized String refresh() throws Exception {
        if (state.taskId().isEmpty()) return "当前没有手机任务。";
        try { return apply(remote.read(state.taskId())); }
        catch (TaskNotFound missing) {
            if (!store.save("")) throw new IllegalStateException("Unable to clear missing task reference");
            state.clear();
            return "当前 Mika 没有找到之前的任务记录，请确认后重新发起任务。";
        }
    }
    synchronized boolean needsUserOrFinished() { return state.needsUserOrFinished(); }
    synchronized boolean isProgress() { return state.isProgress(); }
    synchronized String taskId() { return state.taskId(); }
    private String apply(Snapshot snapshot) {
        if (snapshot == null || !state.taskId().equals(snapshot.id)) throw new IllegalStateException("Unexpected task response");
        if (snapshot.id.equals(sessionTask) && snapshot.conversation != null && !snapshot.conversation.isEmpty()) mikaConversation = snapshot.conversation;
        return state.update(snapshot.state, snapshot.progress, snapshot.question, snapshot.answer);
    }
}
