package cn.yilu.rayneopaseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

final class PairingUi {
    interface Host {
        String blocked();
        String active();
        void apply(PairingData data, String selected);
    }
    private PairingUi() {}
    static void show(Activity activity, Host host, Runnable changed) {
        String blocked = host.blocked();
        if (!blocked.isEmpty()) { notice(activity, "暂时不能配对", blocked); return; }
        PairingScanner.show(activity, value -> load(activity, host, changed, value));
    }
    private static void load(Activity activity, Host host, Runnable changed, String value) {
        String blocked = host.blocked();
        if (!blocked.isEmpty()) { notice(activity, "暂时不能配对", blocked); return; }
        final PairingCode code;
        try { code = PairingCode.parse(value); } catch (IllegalArgumentException invalid) { notice(activity, "无法配对", invalid.getMessage()); return; }
        AtomicBoolean active = new AtomicBoolean(true);
        AlertDialog progress = new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle("正在连接电脑")
            .setMessage("正在检查二维码和电脑连接…").setNegativeButton("取消", (dialog, which) -> active.set(false)).create();
        progress.setOnCancelListener(dialog -> active.set(false)); progress.show();
        new Thread(() -> {
            PairingData data = null; String failure = null;
            try { data = claim(code); }
            catch (IllegalStateException | IllegalArgumentException unavailable) { failure = unavailable.getMessage(); }
            catch (Exception unavailable) { failure = "暂时无法连接电脑，请检查手机网络和电脑连接，再重新扫码。"; }
            final PairingData result = data; final String error = failure;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (!active.get() || activity.isFinishing() || activity.isDestroyed()) return;
                progress.dismiss();
                if (result == null) notice(activity, "尚未配对", error);
                else confirm(activity, host, changed, result);
            });
        }, "rayneo-pairing").start();
    }
    private static PairingData claim(PairingCode code) throws Exception {
        HttpsURLConnection http = PinnedTls.open(code.claimUrl, code.certificateSha256);
        try {
            http.setInstanceFollowRedirects(false); http.setConnectTimeout(8000); http.setReadTimeout(15000);
            http.setRequestMethod("POST"); http.setDoOutput(true); http.setRequestProperty("Content-Type", "application/json");
            byte[] body = new JSONObject().put("version", 1).put("code", code.code).toString().getBytes(StandardCharsets.UTF_8);
            http.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = http.getOutputStream()) { output.write(body); }
            int status = http.getResponseCode();
            if (status == 401) throw new IllegalStateException("二维码已过期或已使用，请在电脑重新生成后再扫。");
            if (status != 200) throw new IllegalStateException("电脑暂时无法完成配对，请检查连接器后重新扫码。");
            JSONObject response = json(http.getInputStream(), 16384);
            if (!(response.opt("version") instanceof Number) || ((Number)response.get("version")).doubleValue() != response.getInt("version"))
                throw new IllegalArgumentException("电脑返回的配对信息无法识别，尚未保存。");
            JSONObject transport = response.optJSONObject("transport");
            PairingData.validateTransport(response.getInt("version"), transport == null ? null : transport.optString("type", ""),
                transport == null ? null : transport.optString("certificateSha256", ""), code);
            JSONObject incoming = response.getJSONObject("profiles");
            Map<String, Map<String, ?>> profiles = new LinkedHashMap<>();
            for (Iterator<String> names = incoming.keys(); names.hasNext();) {
                String name = names.next(); JSONObject profile = incoming.getJSONObject(name);
                if (profile.length() != 3) throw new IllegalArgumentException("电脑返回的配对信息不完整，尚未保存。");
                Map<String, Object> parsed = new HashMap<>();
                parsed.put("endpoint", profile.get("endpoint")); parsed.put("port", profile.get("port")); parsed.put("token", profile.get("token")); profiles.put(name, parsed);
            }
            PairingData data = PairingData.parse(response.getString("computerLabel"), profiles, code);
            for (ConnectionProfiles.Profile profile : data.profiles.values()) checkHealth(profile);
            return data;
        } finally { http.disconnect(); }
    }
    private static JSONObject json(InputStream input, int limit) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024]; int count;
            while ((count = stream.read(buffer)) >= 0) {
                if (bytes.size() + count > limit) throw new IllegalArgumentException("配对信息过大，尚未保存。");
                bytes.write(buffer, 0, count);
            }
            return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
    }
    private static void checkHealth(ConnectionProfiles.Profile profile) throws Exception {
        HttpsURLConnection http = PinnedTls.open(BridgeEndpoint.healthEndpoint(profile.endpoint, profile.port), profile.certificateSha256);
        try {
            http.setInstanceFollowRedirects(false); http.setConnectTimeout(8000); http.setReadTimeout(10000);
            http.setRequestProperty("Authorization", "Bearer " + profile.token);
            if (http.getResponseCode() != 200) throw new IllegalStateException("二维码已识别，但电脑上的助手尚未就绪。请在电脑检查连接后重新扫码。");
            JSONObject health = json(http.getInputStream(), 2048);
            if (!health.optBoolean("ok", false) || !"ready".equals(health.optString("status"))) throw new IllegalStateException("电脑上的助手尚未就绪，请检查连接后重新扫码。");
        } finally { http.disconnect(); }
    }
    private static void confirm(Activity activity, Host host, Runnable changed, PairingData data) {
        Context context = AssistantSettingsUi.dialogContext(activity);
        LinearLayout body = new LinearLayout(context); body.setOrientation(LinearLayout.VERTICAL);
        int pad = AssistantSettingsUi.dp(activity, 24); body.setPadding(pad, pad / 2, pad, pad);
        ArrayList<String> included = new ArrayList<>(), missing = new ArrayList<>();
        for (String backend : new String[]{ConnectionProfiles.PASEO, ConnectionProfiles.CODEX}) {
            (data.profiles.containsKey(backend) ? included : missing).add(ConnectionProfiles.label(backend));
        }
        String message = "将切换到这台电脑。\n本次包含：" + android.text.TextUtils.join("、", included) + "。";
        if (!missing.isEmpty()) message += "\n未包含 " + android.text.TextUtils.join("、", missing) + "，对应的旧电脑连接配置将被清除。";
        TextView label = new TextView(context); label.setText(message); label.setTextSize(15); body.addView(label);
        TextView error = new TextView(context); error.setTextSize(14); body.addView(error);
        AlertDialog confirm = new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle("连接到“" + data.computerLabel + "”")
            .setView(body).setNegativeButton("取消", null).setPositiveButton("确认配对", null).create();
        confirm.setOnShowListener(ignored -> confirm.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener(view -> {
            String blocked = host.blocked(); if (!blocked.isEmpty()) { error.setText(blocked); return; }
            try {
                host.apply(data, host.active()); confirm.dismiss(); changed.run();
                notice(activity, "配对完成", "已保存“" + data.computerLabel + "”的配置。请在助手设置中选择要使用的渠道。");
            } catch (RuntimeException unavailable) { error.setText("尚未保存配对设置，请确认没有待发送内容或运行中的请求后重试。"); }
        }));
        confirm.show();
    }
    private static void notice(Activity activity, String title, String text) {
        if (!activity.isFinishing() && !activity.isDestroyed()) new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle(title).setMessage(text).setPositiveButton("知道了", null).show();
    }
}
