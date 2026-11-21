package cn.yilu.rayneopaseo;

final class MikaTaskState {
    private String taskId = "", state = "", lastNotice = "";
    String taskId() { return taskId; }
    void clear() { taskId = ""; state = ""; lastNotice = ""; }
    boolean isProgress() { return "starting".equals(state) || "queued".equals(state) || "running".equals(state) || "paused".equals(state); }
    boolean needsUserOrFinished() {
        return "waiting_for_answer".equals(state) || "waiting_on_phone".equals(state) || "done".equals(state)
            || "failed".equals(state) || "cancelled".equals(state) || "unknown".equals(state);
    }
    String nextAction(String text) {
        boolean terminal = state.isEmpty() || "done".equals(state) || "failed".equals(state) || "cancelled".equals(state);
        if (terminal) return "start";
        if ("取消手机任务".equals(text == null ? "" : text.trim())) return "cancel";
        if ("waiting_for_answer".equals(state)) return "answer";
        if ("waiting_on_phone".equals(state)) return "on_phone";
        if ("running".equals(state)) return "steer";
        if ("unknown".equals(state)) return "unknown";
        return "busy";
    }
    void begin(String id) {
        if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new IllegalArgumentException();
        taskId = id; state = "unknown"; lastNotice = "";
    }
    String update(String status, String progress, String question, String answer) {
        if (taskId.isEmpty() || status == null) throw new IllegalStateException();
        String notice;
        switch (status) {
            case "starting": notice = "正在启动。"; break;
            case "queued": notice = "正在排队。"; break;
            case "running": notice = "unknown".equals(state) ? "正在启动。" : ""; break;
            case "paused": notice = "任务已暂停，请在手机上查看。"; break;
            case "waiting_for_answer": notice = value(question, "请回答手机上的问题。"); break;
            case "waiting_on_phone": notice = "请在手机上处理。"; break;
            case "done": notice = value(answer, "任务已完成。"); break;
            case "failed": notice = value(answer, "任务未完成，请在手机上查看。"); break;
            case "cancelled": notice = "任务已取消。"; break;
            default: throw new IllegalArgumentException("Unknown task status");
        }
        state = status;
        if (notice.isEmpty()) return "";
        if (notice.equals(lastNotice)) return "";
        lastNotice = notice;
        return notice;
    }
    private static String value(String text, String fallback) {
        return text == null || text.trim().isEmpty() ? fallback : text.trim();
    }
}
