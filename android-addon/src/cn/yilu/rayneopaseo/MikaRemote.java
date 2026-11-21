package cn.yilu.rayneopaseo;

import org.json.JSONObject;
import org.json.JSONArray;

final class MikaRemote implements MikaTaskCoordinator.Remote {
    private final MikaLocalHttp http;
    MikaRemote(MikaLocalHttp http) { this.http = http; }
    private JSONObject deviceCall(String name) throws Exception {
        JSONObject call = new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", "tools/call")
            .put("params", new JSONObject().put("name", name).put("arguments", new JSONObject()));
        MikaHttp.Result response = http.deviceCall(call.toString());
        if (response.status != 200) throw new IllegalStateException("Device request rejected");
        JSONObject result = new JSONObject(response.body).getJSONObject("result");
        if (result.optBoolean("isError", false)) throw new IllegalStateException("Device request failed");
        return result.getJSONObject("structuredContent");
    }
    public String prepare() throws Exception {
        JSONObject state = deviceCall("mika_device_state");
        if (state.getJSONObject("device").optBoolean("ready", false)) return "";
        if (!state.optBoolean("enabled", false)) return "请在 Mika 开启远程解锁，任务未发送。";
        if (state.optBoolean("attempt_blocked", false)) return "请在 Mika 重新保存锁屏凭据，任务未发送。";
        JSONObject unlocked = deviceCall("mika_unlock_device");
        if ("unlocked".equals(unlocked.optString("status")) && unlocked.getJSONObject("device").optBoolean("ready", false)) return "";
        String code = unlocked.optString("status");
        if ("credential_required".equals(code)) return "请在 Mika 保存锁屏凭据，任务未发送。";
        if ("attempt_blocked".equals(code) || "unlock_failed".equals(code)) return "自动解锁失败，请在手机上检查并重新保存凭据，任务未发送。";
        if ("unsupported_keyguard".equals(code)) return "手机锁屏方式暂不支持自动解锁，任务未发送。";
        return "自动解锁未完成，请在手机上检查，任务未发送。";
    }
    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        MikaHttp.Result result = http.request(method, path, body == null ? null : body.toString(), 15000);
        if (result.status < 200 || result.status >= 300) throw new IllegalStateException("Mika request rejected");
        return new JSONObject(result.body);
    }
    private MikaTaskCoordinator.Snapshot snapshot(JSONObject value) throws Exception {
        Object question = value.opt("question");
        String text = question instanceof JSONObject ? ((JSONObject)question).optString("text", "") : question instanceof String ? (String)question : "";
        String status = value.getString("status");
        String answer = "failed".equals(status) ? value.optString("reason", "") : value.optString("answer", "");
        return new MikaTaskCoordinator.Snapshot(value.getString("task_id"), status, value.optString("progress", ""), text, answer, value.optString("conversation", ""));
    }
    public MikaTaskCoordinator.Snapshot start(String goal, String id, String conversation) throws Exception {
        JSONObject body = new JSONObject().put("goal", goal).put("request_id", id);
        if (conversation != null && !conversation.isEmpty()) body.put("conversation", conversation);
        return snapshot(request("POST", "/tasks", body));
    }
    public MikaTaskCoordinator.Snapshot read(String id) throws Exception {
        MikaHttp.Result result = http.request("GET", "/tasks/" + id, null, 15000);
        if (result.status == 404) throw new MikaTaskCoordinator.TaskNotFound();
        if (result.status < 200 || result.status >= 300) throw new IllegalStateException("Mika request rejected");
        return snapshot(new JSONObject(result.body));
    }
    void readProgress(String id, MikaProgress tracker) throws Exception {
        JSONArray events = request("GET", "/tasks/" + id + "/export", null).getJSONArray("events");
        java.util.Map<Integer, String> reasons = new java.util.HashMap<>();
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.getJSONObject(i);
            int step = event.optInt("step", 0);
            if ("model_reply".equals(event.optString("type"))) {
                try { reasons.put(step, new JSONObject(event.optString("argsJson", "{}")).optString("reason", "")); }
                catch (Exception invalid) { reasons.put(step, ""); }
            } else if ("activity".equals(event.optString("type"))) {
                tracker.action(step, reasons.get(step), event.optString("effect", ""));
            }
        }
    }
    public void send(String action, String id, String message) throws Exception {
        JSONObject body = new JSONObject(); if (!"cancel".equals(action)) body.put("text", message);
        JSONObject result = request("POST", "/tasks/" + id + "/" + action, body);
        if (!result.optBoolean("accepted", false)) throw new IllegalStateException("Mika action not accepted");
    }
    boolean healthy() throws Exception { return request("GET", "", null).optInt("api_version", 0) == 1; }
}
