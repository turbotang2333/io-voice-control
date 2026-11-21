package cn.yilu.rayneopaseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.CheckBox;
import android.widget.Button;
import android.widget.Switch;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native assistant integration with pinned USB TLS and configurable public HTTPS. */
public final class ProbeAddon {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor();
    private static final ExecutorService HEALTH_NETWORK = Executors.newSingleThreadExecutor();
    private static final TurnGate TURN = new TurnGate();
    private static final NativeInputTrial NATIVE_INPUT_TRIAL = new NativeInputTrial();
    private static long nativeTrialEpoch;
    private static boolean nativeTrialPaseo;
    private static Object nativeTrialTemplate;
    private static String nativeTrialAsrSession = "";
    private static boolean nativeTrialBackgroundDisplay;
    private static long nativeLastInputAt;
    private static Object retiredNativeInputSource;
    private static long nativeTrialStartedAt;
    private static int nativeTrialAudioStarts;
    private static final AtomicLong NATIVE_AUDIO_PACKETS = new AtomicLong();
    private static volatile long nativeLastAudioAt;
    private static Object nativeTrialVad;
    private static long nativeTrialOriginalBos;
    private static volatile NativeBackgroundAsr nativeBackgroundAsr;
    private static long nativeBackgroundSegment;
    private static final ContinuousDraft CONTINUOUS_DRAFT = new ContinuousDraft();
    private static final AtomicLong CONTINUOUS_GENERATION = new AtomicLong();
    private static volatile boolean continuousBusy;
    private static DisplayChunks continuousDisplayed = new DisplayChunks();
    private static int lensNoticeId = 74670;
    private static Context app;
    private static SharedPreferences settings;
    private static MikaTaskCoordinator mikaCoordinator;
    private static String mikaGlassesSession = "";
    private static InteractionSettings interactionSettings;
    private static ShortcutSettings shortcutSettings;
    private static ShortcutSettings codexShortcutSettings;
    private static InteractionPreferences replyPreferences = InteractionPreferences.defaults();
    private static final NavigationSession NAVIGATION = new NavigationSession();
    private static volatile String status = "扩展已加载，默认关闭";
    private static Object replySource, replyTemplate;
    private static TurnFinalizer finalizer;
    private static Object completedSource;
    private static volatile HttpsURLConnection connection;
    private static DisplayChunks displayed = new DisplayChunks();
    private static final AnswerBrowser ANSWER_BROWSER = new AnswerBrowser();
    private static Object previousFinalSource;
    private static String previousFinalSession;
    private static long previousFinalAt;
    private static int partialsSinceFinal;
    interface CompletedReplyObserver {
        boolean completed(Object source, String question, String fullAnswer, String outcome);
    }
    private static CompletedReplyObserver completedReplyObserver;
    static void setCompletedReplyObserver(CompletedReplyObserver observer) { completedReplyObserver = observer; }
    static boolean closeForReplyReading(Object source) throws Exception {
        if (mode() != 3 || !NATIVE_INPUT_TRIAL.owns(source) || !NATIVE_INPUT_TRIAL.replyStarted()) return false;
        endNativeInputTrial("reading_trial_handoff", true);
        TURN.reset(); disconnect(); replySource = replyTemplate = null;
        Object owner = source.getClass().getField("a").get(source);
        owner.getClass().getMethod(HostBindings.ASSISTANT_EXIT_METHOD, String.class, boolean.class, boolean.class)
            .invoke(owner, "paseo_reading_trial", true, false);
        trace("native assistant exit requested readingTrial=true");
        return true;
    }
    private static volatile String promptProbeSid;
    private static volatile long promptProbeStartedAt;
    private static volatile boolean captionProbeLayoutSent;
    private static volatile boolean captionHybridActive;
    private static final AtomicLong PROMPT_AUDIO_PACKETS = new AtomicLong();
    // Diagnostics contain only routing flags, timings and lengths, never speech or credentials.
    private static void trace(String metadata) {
        Log.i("PaseoProbe", metadata);
        DiagnosticTrace.append(metadata, System.currentTimeMillis());
    }
    public static void observePromptPacket(Object packet) {
        if (NATIVE_INPUT_TRIAL.active()) observeNativeTransport(packet);
        if (promptProbeSid == null) return;
        try {
            Object business = packet.getClass().getField("p").get(packet);
            String businessName = ((Enum<?>) business).name();
            if (!"PROACTIVE_AI".equals(businessName) && !"AI_SUBTITLE".equals(businessName)) return;
            byte[] bytes = (byte[]) packet.getClass().getField("i").get(packet);
            Class<?> messageClass = app.getClassLoader().loadClass("com.rayneo.airuntime.tansport.proto.TransportMessage$CaptionMsg");
            Object message = messageClass.getMethod("parseFrom", byte[].class).invoke(null, (Object) bytes);
            int type = (int) messageClass.getMethod("getType").invoke(message);
            if (type == 4) {
                long count = PROMPT_AUDIO_PACKETS.incrementAndGet();
                if (count == 1 || count % 100 == 0) trace("prompt audio packets=" + count + " elapsedMs="
                    + (android.os.SystemClock.elapsedRealtime() - promptProbeStartedAt));
            } else if (type == 2 || type == 3 || type == 8) {
                String body = (String) messageClass.getMethod("getMessage").invoke(message);
                JSONObject metadata = new JSONObject(body);
                if (!promptProbeSid.equals(metadata.optString("sid"))) return;
                trace("display received business=" + businessName + " type=" + type + " elapsedMs="
                    + (android.os.SystemClock.elapsedRealtime() - promptProbeStartedAt)
                    + " code=" + metadata.optInt("code", -1)
                    + " reason=" + metadata.optInt("reason_code", -1)
                    + " audioPackets=" + PROMPT_AUDIO_PACKETS.get());
                if (captionHybridActive && "PROACTIVE_AI".equals(businessName) && type == 2 && metadata.optInt("code") == 1
                    && !captionProbeLayoutSent) {
                    captionProbeLayoutSent = true;
                    MAIN.post(() -> captionPageLayout(promptProbeSid));
                }
            }
        } catch (Exception failure) {
            trace("prompt observation failed cause=" + failure.getClass().getSimpleName());
        }
    }
    private static void observeNativeTransport(Object packet) {
        try {
            Object business = packet.getClass().getField("p").get(packet);
            if (!"VOICE_ASSISTANT".equals(((Enum<?>) business).name())) return;
            byte[] bytes = (byte[]) packet.getClass().getField("i").get(packet);
            Class<?> messageClass = app.getClassLoader().loadClass("com.rayneo.airuntime.tansport.proto.TransportMessage$AssistantMsg");
            Object message = messageClass.getMethod("parseFrom", byte[].class).invoke(null, (Object) bytes);
            int type = (int) messageClass.getMethod("getType").invoke(message);
            long now = android.os.SystemClock.elapsedRealtime();
            if (type == 3) {
                nativeLastAudioAt = now;
                long count = NATIVE_AUDIO_PACKETS.incrementAndGet();
                if (count == 1 || count % 100 == 0) trace("native transport audioPackets=" + count
                    + " elapsedMs=" + (now - nativeTrialStartedAt));
                NativeBackgroundAsr background = nativeBackgroundAsr;
                if (background != null) background.offer(message);
            } else {
                int rc = -1;
                if (type == 8) {
                    String body = (String) messageClass.getMethod("getMessage").invoke(message);
                    rc = new JSONObject(body).optInt("rc", -1);
                    final int exitReason = rc;
                    serial(() -> NATIVE_INPUT_TRIAL.observeTransportExit(exitReason, now));
                }
                trace("native transport control type=" + type + " rc=" + rc + " audioPackets="
                    + NATIVE_AUDIO_PACKETS.get() + " elapsedMs=" + (now - nativeTrialStartedAt));
            }
        } catch (Exception failure) { trace("native transport observation failed cause=" + failure.getClass().getSimpleName()); }
    }
    private static void notifyLens(String title, String body, int id) {
        if (app == null || body == null || body.isEmpty()) return;
        try {
            NotificationManager manager = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            String channel = "paseo_glasses_test";
            manager.createNotificationChannel(new NotificationChannel(channel, "Paseo 镜片测试", NotificationManager.IMPORTANCE_HIGH));
            Notification notification = new Notification.Builder(app, channel)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .build();
            manager.notify(id, notification);
            trace("lens notification posted chars=" + body.length());
        } catch (RuntimeException failure) { trace("lens notification failed"); }
    }
    public static void observeTeleprompterAsr(Object source, String text, boolean finished) {
        if (mode() != 2) return;
        if (continuousBusy) return;
        ContinuousDraft.Result result = CONTINUOUS_DRAFT.accept(text, finished);
        trace("teleprompter asr final=" + finished + " chars=" + (text == null ? 0 : text.length())
            + " draftChars=" + CONTINUOUS_DRAFT.snapshot().length()
            + " action=" + result.kind.name().toLowerCase(java.util.Locale.ROOT)
            + " wouldSendChars=" + result.text.length());
        if (result.kind == ContinuousDraft.Kind.CANCEL) {
            MAIN.post(() -> { if (mode() == 2) notifyLens("Paseo", "已取消发送", ++lensNoticeId); });
        } else if (result.kind == ContinuousDraft.Kind.SEND) {
            MAIN.post(() -> startContinuousTurn(result.text));
        }
    }
    private static void startContinuousTurn(String question) {
        if (mode() != 2 || continuousBusy || question.isEmpty()) return;
        if (VoiceCommand.isModeQuery(question)) { notifyLens("连接模式", currentModeText(), ++lensNoticeId); return; }
        if (question.length() > 4096) {
            notifyLens("Paseo", "内容过长，请取消发送后缩短问题", ++lensNoticeId);
            return;
        }
        continuousBusy = true;
        continuousDisplayed = new DisplayChunks();
        long generation = CONTINUOUS_GENERATION.incrementAndGet();
        ConnectionProfiles.Profile profile = activeConnection();
        String session = UUID.randomUUID().toString();
        trace("continuous send chars=" + question.length());
        NETWORK.execute(() -> requestContinuous(generation, question, session, profile));
    }
    private static boolean continuousAccepts(long generation) {
        return mode() == 2 && continuousBusy && CONTINUOUS_GENERATION.get() == generation;
    }
    private static void probePromptPage() {
        try {
            String sid = UUID.randomUUID().toString().replace("-", "");
            captionHybridActive = false;
            promptProbeSid = sid;
            promptProbeStartedAt = android.os.SystemClock.elapsedRealtime();
            PROMPT_AUDIO_PACKETS.set(0);
            JSONObject settings = new JSONObject().put("mode", "conversation")
                .put("source_language", "zh-CN").put("target_language", "zh-CN")
                .put("save_audio", false).put("direction", "ahead");
            LensPromptProbe.send(app, 1, new JSONObject().put("sid", sid).put("trigger", 1)
                .put("force", false).put("code", 0).put("settings", settings));
            for (int second : new int[]{2, 6, 10, 14, 18}) {
                MAIN.postDelayed(() -> promptPageText(sid, "处理中", 1), second * 1000L);
            }
            MAIN.postDelayed(() -> promptPageText(sid, "已完成", 1), 22000);
            MAIN.postDelayed(() -> {
                try { LensPromptProbe.send(app, 3, new JSONObject().put("sid", sid).put("reason_code", 2).put("text", "")); }
                catch (Exception ignored) { trace("prompt stop failed"); }
                trace("prompt local stop audioPackets=" + PROMPT_AUDIO_PACKETS.get());
                promptProbeSid = null;
            }, 30000);
        } catch (Exception failure) { trace("prompt start failed"); }
    }
    private static void probeCaptionPage() {
        try {
            String sid = UUID.randomUUID().toString().replace("-", "");
            promptProbeSid = sid;
            promptProbeStartedAt = android.os.SystemClock.elapsedRealtime();
            PROMPT_AUDIO_PACKETS.set(0);
            captionProbeLayoutSent = false;
            captionHybridActive = true;
            JSONObject settings = new JSONObject().put("mode", "conversation")
                .put("source_language", "zh-CN").put("target_language", "zh-CN")
                .put("save_audio", false).put("direction", "ahead");
            LensPromptProbe.send(app, "PROACTIVE_AI", 1, new JSONObject().put("sid", sid)
                .put("trigger", 1).put("force", false).put("code", 0).put("settings", settings));
            MAIN.postDelayed(() -> captionPageText(sid, "苹果"), 3000);
            MAIN.postDelayed(() -> captionPageText(sid, "香蕉"), 18000);
            MAIN.postDelayed(() -> captionPageText(sid, "梨子"), 30000);
            MAIN.postDelayed(() -> {
                try { LensPromptProbe.send(app, "AI_SUBTITLE", 3, new JSONObject().put("sid", sid)
                    .put("reason_code", 10).put("text", "")); }
                catch (Exception ignored) { trace("caption stop failed"); }
                try { LensPromptProbe.send(app, "PROACTIVE_AI", 3, new JSONObject().put("sid", sid)
                    .put("reason_code", 2).put("text", "")); }
                catch (Exception ignored) { trace("prompt stop failed"); }
                trace("caption local stop audioPackets=" + PROMPT_AUDIO_PACKETS.get());
                captionHybridActive = false;
                promptProbeSid = null;
            }, 45000);
        } catch (Exception failure) { trace("caption start failed"); }
    }
    private static void captionPageLayout(String sid) {
        if (sid == null) return;
        try {
            JSONObject config = new JSONObject().put("font_size", 2).put("content_width", 100)
                .put("max_lines", 5).put("position", "center")
                .put("is_display", true).put("straight_view", "original");
            LensPromptProbe.send(app, "AI_SUBTITLE", 7, new JSONObject().put("sid", sid)
                .put("force", false).put("scope", "temporary").put("config", config));
        } catch (Exception failure) { trace("caption layout failed"); }
    }
    private static void captionPageText(String sid, String caption) {
        try {
            JSONObject content = new JSONObject().put("source_transcript", caption);
            LensPromptProbe.send(app, "AI_SUBTITLE", 5, new JSONObject().put("sid", sid).put("mode", 3)
                .put("status", 0).put("content", content));
        } catch (Exception failure) { trace("caption text failed"); }
    }
    private static void promptPageText(String sid, String answer, int status) {
        try {
            JSONObject content = new JSONObject().put("source_transcript", "Paseo 对话页测试")
                .put("target_translation", answer).put("keyword_info", JSONObject.NULL).put("label", 0);
            LensPromptProbe.send(app, 5, new JSONObject().put("sid", sid).put("mode", 4)
                .put("status", status).put("content", content));
        } catch (Exception failure) { trace("prompt text failed"); }
    }
    private static void continuousPreview(long generation, String snapshot) {
        if (!continuousAccepts(generation)) return;
        String delta = continuousDisplayed.preview(snapshot);
        if (delta == null) return;
        notifyLens("Paseo", delta, ++lensNoticeId);
        continuousDisplayed.previewDelivered(snapshot);
        trace("continuous preview chars=" + delta.length());
    }
    private static void continuousFinish(long generation, String answer) {
        if (!continuousAccepts(generation)) return;
        String delta = continuousDisplayed.finalChunk(answer);
        if (!delta.isEmpty()) notifyLens("Paseo", delta, ++lensNoticeId);
        continuousBusy = false;
        trace("continuous final chars=" + delta.length());
    }
    private ProbeAddon() {}
    private static void serial(Runnable action) { if (Looper.myLooper() == Looper.getMainLooper()) action.run(); else MAIN.post(action); }
    private static Map<String, ?> settingsValues() { return NAVIGATION.configuration(); }
    private static int mode() { Object value = settingsValues().get("mode"); return value instanceof Number ? ((Number)value).intValue() : 0; }
    private static ConnectionProfiles.Profile activeConnection() {
        Map<String, ?> values = settingsValues();
        return ConnectionProfiles.load(values, ConnectionProfiles.active(values));
    }
    private static String currentModeText() {
        String selected = ConnectionProfiles.panelMode(settingsValues());
        return "当前模式：" + (ConnectionProfiles.OFFICIAL.equals(selected) ? "雷鸟官方" : ConnectionProfiles.label(selected)) + "。";
    }
    private static boolean connectionBusy() {
        return continuousBusy || TURN.pending() || (finalizer != null && !finalizer.isClosed())
            || (NATIVE_INPUT_TRIAL.active() && NATIVE_INPUT_TRIAL.inputFinished() && !NATIVE_INPUT_TRIAL.question().isEmpty());
    }
    private static int connectionDraftChars() {
        return NATIVE_INPUT_TRIAL.draftLength() + CONTINUOUS_DRAFT.snapshot().length();
    }
    public static void install(Activity activity) {
        serial(() -> {
            app = activity.getApplicationContext();
            if (SettingsRecovery.handle(app, connectionDraftChars(), connectionBusy())) return;
            try { DiagnosticTrace.configure(app.getExternalFilesDir(null)); }
            catch (RuntimeException ignored) { DiagnosticTrace.configure(null); }
            settings = app.getSharedPreferences("rayneo_paseo_probe", Context.MODE_PRIVATE);
            if (interactionSettings == null) {
                final SharedPreferences vocabulary = app.getSharedPreferences("rayneo_paseo_interaction", Context.MODE_PRIVATE);
                interactionSettings = new InteractionSettings(new InteractionSettings.Store() {
                    public Map<String, ?> read() { return vocabulary.getAll(); }
                    public boolean commit(Map<String, String> values) {
                        SharedPreferences.Editor editor = vocabulary.edit();
                        for (Map.Entry<String, String> entry : values.entrySet()) editor.putString(entry.getKey(), entry.getValue());
                        return editor.commit();
                    }
                });
                NATIVE_INPUT_TRIAL.configure(interactionSettings.current());
            }
            if (shortcutSettings == null) shortcutSettings = loadShortcuts(ConnectionProfiles.PASEO);
            if (codexShortcutSettings == null) codexShortcutSettings = loadShortcuts(ConnectionProfiles.CODEX);
            interactionSettings.setValidator(next -> {
                shortcutSettings.validateVocabulary(next); codexShortcutSettings.validateVocabulary(next);
            });
            NATIVE_INPUT_TRIAL.configureShortcuts(activeShortcuts().current());
            try { NAVIGATION.initialize(navigationStore()); }
            catch (IllegalStateException failure) { status = "导航会话未初始化，暂不发送；请核对手机存储"; }
            ViewGroup root = activity.findViewById(android.R.id.content);
            if (!(root instanceof FrameLayout) || root.findViewWithTag("paseo-probe-entry") != null) return;
            TextView button = new TextView(activity);
            button.setTag("paseo-probe-entry"); button.setText("助手设置");
            button.setTextColor(Color.WHITE); button.setBackgroundColor(Color.rgb(30, 60, 65));
            button.setGravity(Gravity.CENTER); button.setPadding(18, 12, 18, 12);
            button.setMinHeight(AssistantSettingsUi.dp(activity, 48));
            FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.RIGHT);
            layout.topMargin = (int)(90 * activity.getResources().getDisplayMetrics().density);
            layout.rightMargin = AssistantSettingsUi.dp(activity, 12);
            root.addView(button, layout); button.setOnClickListener(view -> showSettings(activity));
        });
    }
    private static void showSettings(Activity activity) {
        AssistantSettingsUi.show(activity, new AssistantSettingsUi.Host() {
            public Map<String, ?> values() { return settingsValues(); }
            public String blocked() { return ConnectionProfiles.blocked(connectionDraftChars(), connectionBusy()); }
            public void select(String selected) {
                applyPanelConfiguration(ConnectionProfiles.switchMode(settingsValues(), selected, connectionDraftChars(), connectionBusy()));
            }
            public void save(String backend, ConnectionProfiles.Profile profile) {
                ConnectionProfiles.Profile paseo = ConnectionProfiles.PASEO.equals(backend) ? profile : ConnectionProfiles.load(settingsValues(), ConnectionProfiles.PASEO);
                ConnectionProfiles.Profile codex = ConnectionProfiles.CODEX.equals(backend) ? profile : ConnectionProfiles.load(settingsValues(), ConnectionProfiles.CODEX);
                applyPanelConfiguration(ConnectionProfiles.update(settingsValues(), backend, paseo, codex, 3, connectionDraftChars(), connectionBusy()));
            }
            public int mikaPort() { return new MikaCredentials(app).port(); }
            public void saveMika(int port, String token) {
                try {
                    new MikaCredentials(app).save(port, token);
                    Map<String, Object> changes = new java.util.HashMap<>();
                    changes.put("mika.configured", true); changes.put("connection.backend", ConnectionProfiles.MIKA); changes.put("mode", 3);
                    applyPanelConfiguration(changes); mikaCoordinator = null;
                } catch (Exception failure) { throw new IllegalArgumentException("无法保存 Mika 连接"); }
            }
            public void check(String backend, AssistantSettingsUi.StatusCallback callback) {
                if (ConnectionProfiles.MIKA.equals(backend)) {
                    HEALTH_NETWORK.execute(() -> {
                        String result;
                        try { MikaCredentials c = new MikaCredentials(app); result = new MikaRemote(new MikaLocalHttp(c.port(), c.token())).healthy() ? "Mika 本机连接正常" : "Mika 接口版本不兼容"; }
                        catch (Exception failure) { result = "无法连接，请检查 Mika 网络访问和令牌"; }
                        final String message = result; MAIN.post(() -> callback.ready(message));
                    }); return;
                }
                ConnectionProfiles.Profile saved = ConnectionProfiles.load(settingsValues(), backend);
                HEALTH_NETWORK.execute(() -> { String result = checkConnectionHealth(saved); MAIN.post(() -> callback.ready(result)); });
            }
            public void pair(Runnable changed) {
                PairingUi.show(activity, new PairingUi.Host() {
                    public String blocked() { return ConnectionProfiles.blocked(connectionDraftChars(), connectionBusy()); }
                    public String active() { String active = ConnectionProfiles.active(settingsValues()); return ConnectionProfiles.MIKA.equals(active) ? ConnectionProfiles.PASEO : active; }
                    public void apply(PairingData data, String selected) {
                        applyPanelConfiguration(data.changes(settingsValues(), selected, connectionDraftChars(), connectionBusy()));
                    }
                }, changed);
            }
            public void shortcuts() {
                final String backend = ConnectionProfiles.panelMode(settingsValues());
                final ShortcutSettings selected = shortcutsFor(backend);
                ShortcutSettingsUi.show(activity, selected, interactionSettings, new ShortcutSettingsUi.Resolver() {
                    public String blocked() {
                        if (!backend.equals(ConnectionProfiles.panelMode(settingsValues()))) return "连接模式已变化，请返回后重新打开快捷方式";
                        return ConnectionProfiles.blocked(connectionDraftChars(), connectionBusy());
                    }
                    public void resolve(String kind, String seed, ShortcutBindings.Entry existing, ShortcutSettingsUi.Callback callback) {
                        resolveShortcutTarget(kind, seed, existing, callback);
                    }
                }, () -> NATIVE_INPUT_TRIAL.configureShortcuts(activeShortcuts().current()), backend);
            }
            public void commands(String backend) {
                InteractionSettingsUi.showCommands(activity, interactionSettings, () -> NATIVE_INPUT_TRIAL.configure(interactionSettings.current()), backend);
            }
            public void prompts() {
                InteractionSettingsUi.showPrompts(activity, interactionSettings, () -> NATIVE_INPUT_TRIAL.configure(interactionSettings.current()));
            }
        });
    }
    private static void applyPanelConfiguration(Map<String, Object> changes) {
        NAVIGATION.advance(navigationStore(), changes);
        ANSWER_BROWSER.clear(); cancel(); status = currentModeText();
        NATIVE_INPUT_TRIAL.configureShortcuts(activeShortcuts().current());
    }
    private static ShortcutSettings loadShortcuts(final String backend) {
        final SharedPreferences shortcuts = app.getSharedPreferences("rayneo_paseo_shortcuts", Context.MODE_PRIVATE);
        return new ShortcutSettings(new ShortcutSettings.Store() {
            public Map<String, ?> read() { return ShortcutScopes.read(shortcuts.getAll(), backend); }
            public boolean commit(Map<String, String> values) {
                Map<String, Object> merged = ShortcutScopes.replace(shortcuts.getAll(), backend, values);
                for (Object value : merged.values()) if (!(value instanceof String)) return false;
                SharedPreferences.Editor editor = shortcuts.edit().clear();
                for (Map.Entry<String, Object> entry : merged.entrySet()) editor.putString(entry.getKey(), (String)entry.getValue());
                return editor.commit();
            }
        }, interactionSettings.current());
    }
    private static ShortcutSettings shortcutsFor(String backend) {
        return ConnectionProfiles.CODEX.equals(backend) ? codexShortcutSettings : shortcutSettings;
    }
    private static ShortcutSettings activeShortcuts() { return shortcutsFor(ConnectionProfiles.active(settingsValues())); }
    private static void cancel() {
        ANSWER_BROWSER.stopBrowsing();
        endNativeInputTrial("cancelled", true);
        closeReply();
        TURN.reset(); replySource = replyTemplate = null;
        CONTINUOUS_DRAFT.reset();
        CONTINUOUS_GENERATION.incrementAndGet(); continuousBusy = false;
        displayed = new DisplayChunks();
        disconnect();
    }
    private static void closeReply() {
        if (finalizer != null && finalizer.closeSafely()) completedSource = replySource;
        finalizer = null;
    }
    private static void disconnect() {
        HttpsURLConnection old = connection; connection = null;
        if (old != null) { Thread closer = new Thread(old::disconnect, "paseo-disconnect"); closer.setDaemon(true); closer.start(); }
    }
    private static void original(Object target, String name, Class<?>[] signature, Object... values) throws Exception {
        Method method = target.getClass().getMethod("paseoProbeOriginal_" + name, signature);
        method.invoke(target, values);
    }
    private static Object get(Object target, String field) throws Exception { return target.getClass().getMethod("get" + field).invoke(target); }
    private static String str(Object value) { return value instanceof String ? (String)value : ""; }
    private static void beginNativeInputTrial(boolean showToast) {
        if (mode() == 0) { Toast.makeText(app, "请先保存回显或 Paseo 模式", Toast.LENGTH_LONG).show(); return; }
        if (interactionSettings == null || !interactionSettings.valid()) {
            status = "口令设置无法读取，请在口令与提示中恢复默认后继续";
            Toast.makeText(app, status, Toast.LENGTH_LONG).show(); return;
        }
        if (activeShortcuts() == null || !activeShortcuts().valid()) {
            status = "快捷方式设置无法读取，请在手机快捷方式中重置后继续";
            Toast.makeText(app, status, Toast.LENGTH_LONG).show(); return;
        }
        trace("native input begin previousDraftChars=" + NATIVE_INPUT_TRIAL.draftLength()
            + " wasActive=" + NATIVE_INPUT_TRIAL.active());
        Object previousSource = NATIVE_INPUT_TRIAL.source();
        boolean resumed = !showToast && mode() == 3
            && NATIVE_INPUT_TRIAL.resumeAfterSecondaryWake(android.os.SystemClock.elapsedRealtime());
        if (resumed) {
            retiredNativeInputSource = previousSource;
            stopNativeInputCapture();
            trace("native input resumed afterSecondaryWake=true draftChars=" + NATIVE_INPUT_TRIAL.draftLength());
        } else cancel();
        nativeTrialPaseo = mode() >= 2;
        if (!resumed) {
            NATIVE_INPUT_TRIAL.arm(nativeTrialPaseo);
            mikaGlassesSession = java.util.UUID.randomUUID().toString();
        }
        nativeTrialTemplate = null;
        nativeTrialAsrSession = "";
        nativeTrialBackgroundDisplay = false;
        nativeTrialStartedAt = android.os.SystemClock.elapsedRealtime();
        nativeLastInputAt = nativeTrialStartedAt;
        nativeTrialAudioStarts = 0;
        NATIVE_AUDIO_PACKETS.set(0);
        nativeLastAudioAt = 0;
        long epoch = ++nativeTrialEpoch;
        status = nativeTrialPaseo
            ? "原生口令对话：唤醒眼镜，说完后单独说确认发送，才会交给指定 Agent；建议停顿不超过90秒"
            : "原生输入试验：唤醒眼镜，停顿后继续说，单独说确认发送；仅回显，不提交 Agent";
        trace("native input armed localOnly=" + !nativeTrialPaseo + " limitMs=240000");
        if (showToast) Toast.makeText(app, status, Toast.LENGTH_LONG).show();
        nativeInputHeartbeat(epoch);
        if (mode() != 3) MAIN.postDelayed(() -> { if (nativeTrialEpoch == epoch) endNativeInputTrial("timeout", true); }, 240000);
    }
    private static void nativeInputHeartbeat(long epoch) {
        MAIN.postDelayed(() -> {
            if (nativeTrialEpoch != epoch || !NATIVE_INPUT_TRIAL.active()) return;
            if (mode() == 3 && !NATIVE_INPUT_TRIAL.replyStarted()
                && android.os.SystemClock.elapsedRealtime() - nativeLastInputAt >= 120000) {
                endNativeInputTrial("idle_timeout", true);
                status = "连续对话已因空闲结束，下次使用请重新唤醒";
                return;
            }
            if (NATIVE_INPUT_TRIAL.source() != null) trace("native input heartbeat audioPackets=" + NATIVE_AUDIO_PACKETS.get()
                + " lastAudioAgeMs=" + (nativeLastAudioAt == 0 ? -1 : android.os.SystemClock.elapsedRealtime() - nativeLastAudioAt)
                + " draftChars=" + NATIVE_INPUT_TRIAL.draftLength());
            nativeInputHeartbeat(epoch);
        }, 5000);
    }
    private static void endNativeInputTrial(String reason, boolean close) {
        if (!NATIVE_INPUT_TRIAL.active()) return;
        Object source = NATIVE_INPUT_TRIAL.source();
        if (source != null) retiredNativeInputSource = source;
        boolean replyStarted = NATIVE_INPUT_TRIAL.replyStarted();
        NATIVE_INPUT_TRIAL.stop();
        nativeTrialTemplate = null;
        stopNativeInputCapture();
        trace("native input stopped reason=" + reason + " audioStarts=" + nativeTrialAudioStarts);
        if (close && replyStarted) closeReply();
        else if (close && source != null) {
            try { original(source, "onResponseComplete", new Class<?>[]{}); completedSource = source; }
            catch (Exception failure) { trace("native input completion failed"); }
        }
    }
    private static void stopNativeInputCapture() {
        nativeTrialEpoch++;
        NativeBackgroundAsr background = nativeBackgroundAsr;
        nativeBackgroundAsr = null;
        if (background != null) background.stop();
        if (nativeTrialVad != null) {
            try { nativeTrialVad.getClass().getMethod("setBos", long.class).invoke(nativeTrialVad, nativeTrialOriginalBos); }
            catch (Exception failure) { trace("native input idle restore failed"); }
            nativeTrialVad = null;
        }
    }
    public static void configureNativeInputWorkflow(Object config) {
        if (SettingsRecovery.paused()) return;
        if (mode() == 3) {
            // SDK initialization runs on a worker thread. Prepare the new turn
            // on the UI thread before initWorkflow can start the microphone.
            // A verified secondary wake rebuilds capture without discarding its
            // unsubmitted draft. Other starts retain the normal reset behavior.
            FutureTask<Boolean> prepare = new FutureTask<>(() -> {
                if (mode() != 3) return false;
                beginNativeInputTrial(false);
                return NATIVE_INPUT_TRIAL.active();
            });
            if (Looper.myLooper() == Looper.getMainLooper()) prepare.run();
            else MAIN.post(prepare);
            try {
                if (!prepare.get(3, TimeUnit.SECONDS)) return;
            } catch (Exception failure) {
                prepare.cancel(false);
                status = "口令对话未能启动，请重新唤醒；本轮不会提交";
                trace("native command workflow preparation failed cause=" + failure.getClass().getSimpleName());
                return;
            }
        }
        if (!NATIVE_INPUT_TRIAL.active()) return;
        try {
            Object vad = get(config, "VadConfig");
            if (nativeTrialVad != vad) {
                nativeTrialVad = vad;
                nativeTrialOriginalBos = (long) get(vad, "Bos");
            }
            vad.getClass().getMethod("setBos", long.class).invoke(vad, 210000L);
            trace("native input idle config bosBeforeMs=" + nativeTrialOriginalBos + " bosAfterMs=" + get(vad, "Bos")
                + " eosMs=" + get(vad, "Eos") + " endMs=" + get(vad, "EndSpeechTimeout"));
        } catch (Exception failure) { trace("native input idle config failed cause=" + failure.getClass().getSimpleName()); }
    }
    public static void observeNativeAudioStart(Object source) {
        serial(() -> {
            // This listener is reused by the SDK. A new microphone start marks
            // a new interaction; until then, discard late results of our turn.
            if (retiredNativeInputSource == source) retiredNativeInputSource = null;
            if (!NATIVE_INPUT_TRIAL.active()) return;
            NATIVE_INPUT_TRIAL.bind(source);
            nativeTrialAudioStarts++;
            trace("native input audioStart count=" + nativeTrialAudioStarts + " elapsedMs="
                + (android.os.SystemClock.elapsedRealtime() - nativeTrialStartedAt));
        });
    }
    public static void observeNativeError(Object source, int code, String ignored) {
        serial(() -> {
            if (source == retiredNativeInputSource) return;
            if (!NATIVE_INPUT_TRIAL.active()) return;
            if (NATIVE_INPUT_TRIAL.replyStarted()) {
                trace("native input late error ignored while waiting code=" + code);
                return;
            }
            trace("native input error code=" + code);
            endNativeInputTrial("error", false);
            status = "原生输入试验已因收音错误停止，请勿重复提交";
        });
    }
    private static boolean nativeInputComplete(Object source) {
        if (!NATIVE_INPUT_TRIAL.owns(source)) return false;
        if (NATIVE_INPUT_TRIAL.replyStarted() && !NATIVE_INPUT_TRIAL.exitRequested()) return true;
        trace("native input responseComplete draftChars=" + NATIVE_INPUT_TRIAL.draftLength()
            + " inputFinished=" + NATIVE_INPUT_TRIAL.inputFinished());
        if (NATIVE_INPUT_TRIAL.inputFinished()) {
            String question = NATIVE_INPUT_TRIAL.question();
            boolean exiting = NATIVE_INPUT_TRIAL.exitRequested();
            try {
                String commandDisplay = NATIVE_INPUT_TRIAL.takeCommandDisplay();
                if (!commandDisplay.isEmpty()) {
                    // The background recognizer often finishes before the native
                    // recognizer. Finalize its partial text before stopping audio.
                    original(source, "onAsrResult", new Class<?>[]{String.class, boolean.class, String.class},
                        commandDisplay, true, nativeTrialAsrSession);
                    trace("native command display finalized chars=" + commandDisplay.length());
                }
                if (nativeTrialTemplate == null) throw new IllegalStateException("no template");
                InteractionPreferences preferences = NATIVE_INPUT_TRIAL.preferences();
                String local = exiting ? preferences.text("exited") : !NATIVE_INPUT_TRIAL.localHint().isEmpty()
                    ? NATIVE_INPUT_TRIAL.localHint() : question.isEmpty() ? preferences.text("cancelled") : "本地回显：" + question;
                Object response = copy(nativeTrialTemplate, local, true);
                response.getClass().getMethod("setDomain", String.class).invoke(response, "chat");
                response.getClass().getMethod("setIntent", String.class).invoke(response, "chat");
                response.getClass().getMethod("setSub", String.class).invoke(response, "workflow");
                response.getClass().getMethod("setQuery", String.class).invoke(response, question);
                if (nativeTrialPaseo && !question.isEmpty()) {
                    String session = "native-command-" + UUID.randomUUID();
                    Object template = copy(response, "", false);
                    long generation = NATIVE_INPUT_TRIAL.beginReply(TURN, session);
                    if (generation < 0) throw new IllegalStateException("native input already submitted");
                    if (mode() != 3) stopNativeInputCapture();
                    startReply(generation, source, template, question, session, true);
                    trace("native command submitted chars=" + question.length());
                    return true;
                }
                original(source, "onNlpResult", new Class<?>[]{response.getClass()}, response);
                trace("native input echo delivered chars=" + question.length() + " localOnly=true");
                status = "原生输入试验已回显，待镜片确认；未发送给 Agent";
                if (mode() == 3 && !exiting) {
                    resumeNativeConversation(source, response);
                    return true;
                }
            } catch (Exception failure) { trace("native input echo failed cause=" + failure.getClass().getSimpleName()); }
            endNativeInputTrial("finished", true);
            if (exiting) {
                TURN.reset(); disconnect(); replySource = replyTemplate = null;
                try {
                    // Both pinned hosts use stopAssistant(reason, sendExit, secondaryWakeExit):
                    // stop its workflow and send the normal glasses exit notification.
                    // onResponseComplete alone only reports that one reply is done.
                    Object owner = source.getClass().getField("a").get(source);
                    owner.getClass().getMethod(HostBindings.ASSISTANT_EXIT_METHOD, String.class, boolean.class, boolean.class)
                        .invoke(owner, "paseo_voice_exit", true, false);
                    trace("native assistant exit requested closePage=true");
                    status = "对话已结束，已请求关闭镜片对话框";
                } catch (Exception failure) {
                    trace("native assistant exit failed cause=" + failure.getClass().getSimpleName());
                    status = "已停止输入；关闭对话框失败，可短按表冠关闭";
                }
            }
        } else {
            startNativeBackgroundAsr(source);
        }
        return true;
    }
    private static void resumeNativeConversation(Object source, Object template) throws Exception {
        Object nextTemplate = copy(template, "", false);
        nextTemplate.getClass().getMethod("setRound", int.class).invoke(nextTemplate, (int) get(template, "Round") + 1);
        nextTemplate.getClass().getMethod("setQuery", String.class).invoke(nextTemplate, "");
        if (!NATIVE_INPUT_TRIAL.nextTurn(source)) throw new IllegalStateException("conversation cannot continue");
        nativeTrialTemplate = nextTemplate;
        nativeTrialBackgroundDisplay = true;
        nativeTrialAsrSession = "paseo-continuous-" + UUID.randomUUID();
        nativeLastInputAt = android.os.SystemClock.elapsedRealtime();
        TURN.reset(); replySource = replyTemplate = null; finalizer = null;
        status = "可以直接继续说；单独说确认发送提交，结束对话退出";
        startNativeBackgroundAsr(source);
        trace("native conversation ready nextRound=" + get(nextTemplate, "Round"));
    }
    private static void startNativeBackgroundAsr(Object source) {
            if (nativeBackgroundAsr != null) return;
            final long epoch = nativeTrialEpoch;
            MAIN.postDelayed(() -> {
                if (nativeTrialEpoch != epoch || !NATIVE_INPUT_TRIAL.owns(source) || nativeBackgroundAsr != null) return;
                NativeBackgroundAsr background = new NativeBackgroundAsr();
                nativeBackgroundAsr = background;
                nativeBackgroundSegment = 0;
                try {
                    background.start(app, source, epoch, new NativeBackgroundAsr.Listener() {
                        public void result(String text, boolean finished) {
                            MAIN.post(() -> {
                                if (nativeTrialEpoch != epoch || !NATIVE_INPUT_TRIAL.owns(source)) return;
                                String session = "background-" + nativeBackgroundSegment;
                                NATIVE_INPUT_TRIAL.acceptBackground(source, text, finished, session);
                                if (text != null && !text.trim().isEmpty()) nativeLastInputAt = android.os.SystemClock.elapsedRealtime();
                                if (nativeTrialBackgroundDisplay && !NATIVE_INPUT_TRIAL.replyStarted() && text != null && !text.isEmpty()) {
                                    try {
                                        String inputHint = NATIVE_INPUT_TRIAL.takeInputHint();
                                        original(source, "onAsrResult", new Class<?>[]{String.class, boolean.class, String.class}, inputHint.isEmpty() ? text : inputHint, finished, nativeTrialAsrSession);
                                        if (finished) NATIVE_INPUT_TRIAL.takeCommandDisplay();
                                    } catch (Exception failure) { trace("native background display failed"); }
                                }
                                if (finished) {
                                    nativeBackgroundSegment++;
                                    trace("native background asr final chars=" + (text == null ? 0 : text.length())
                                        + " draftChars=" + NATIVE_INPUT_TRIAL.draftLength() + " inputFinished=" + NATIVE_INPUT_TRIAL.inputFinished());
                                    if (NATIVE_INPUT_TRIAL.inputFinished()) nativeInputComplete(source);
                                }
                            });
                        }
                        public void error(int code) {
                            MAIN.post(() -> {
                                if (nativeTrialEpoch != epoch) return;
                                trace("native background asr error code=" + code);
                                endNativeInputTrial("background_asr_error", true);
                            });
                        }
                    });
                    NATIVE_INPUT_TRIAL.useBackground(source);
                    trace("native background asr started page=native localOnly=" + !nativeTrialPaseo);
                } catch (Exception failure) {
                    trace("native background asr failed cause=" + failure.getClass().getSimpleName());
                    endNativeInputTrial("background_asr_start_failed", true);
                }
            }, 200);
    }
    public static void dispatchAsr(Object source, String text, boolean finished, String session) {
        serial(() -> {
            if (SettingsRecovery.paused()) return;
            if (source == retiredNativeInputSource) return;
            if (mode() == 3 && !NATIVE_INPUT_TRIAL.active()) return;
            if (NATIVE_INPUT_TRIAL.active()) {
                if (nativeTrialBackgroundDisplay) return;
                if (NATIVE_INPUT_TRIAL.replyStarted()) return;
                if (!NATIVE_INPUT_TRIAL.accept(source, text, finished, session)) {
                    trace("native input unrelated asr ignored");
                    return;
                }
                if (session != null && !session.isEmpty()) nativeTrialAsrSession = session;
                if (text != null && !text.trim().isEmpty()) nativeLastInputAt = android.os.SystemClock.elapsedRealtime();
                completedSource = null;
                try {
                    String inputHint = NATIVE_INPUT_TRIAL.takeInputHint();
                    original(source, "onAsrResult", new Class<?>[]{String.class, boolean.class, String.class}, inputHint.isEmpty() ? text : inputHint, finished, session);
                }
                catch (Exception failure) { endNativeInputTrial("asr_callback_failed", true); }
                if (finished) trace("native input asr final chars=" + (text == null ? 0 : text.length())
                    + " draftChars=" + NATIVE_INPUT_TRIAL.draftLength() + " inputFinished=" + NATIVE_INPUT_TRIAL.inputFinished());
                return;
            }
            if (mode() != 0) {
                if (finished) {
                    long now = android.os.SystemClock.elapsedRealtime();
                    trace("asr boundary chars=" + (text == null ? 0 : text.length())
                        + " sameSource=" + (source == previousFinalSource)
                        + " sameSession=" + (previousFinalSession != null && previousFinalSession.equals(session))
                        + " gapMs=" + (previousFinalAt == 0 ? -1 : now - previousFinalAt)
                        + " partials=" + partialsSinceFinal);
                    previousFinalSource = source; previousFinalSession = session; previousFinalAt = now; partialsSinceFinal = 0;
                } else partialsSinceFinal++;
            }
            boolean fresh = mode() != 0 && TURN.recognize(source, text, finished, session);
            if (mode() != 0 && (!finished || fresh)) { closeReply(); replySource = replyTemplate = null; disconnect(); }
            completedSource = null;
            try { original(source, "onAsrResult", new Class<?>[]{String.class, boolean.class, String.class}, text, finished, session); }
            catch (Exception failure) { status = "官方识别回调失败"; cancel(); return; }
            if (mode() == 0) return;
            if (fresh) { status = "识别完成，等待官方普通问答模板"; trace("asr final accepted chars=" + text.length()); }
        });
    }
    public static void dispatchNlp(Object source, Object response) {
        serial(() -> {
            if (SettingsRecovery.paused()) return;
            if (source == retiredNativeInputSource) return;
            if (mode() == 3 && !NATIVE_INPUT_TRIAL.active()) return;
            if (NATIVE_INPUT_TRIAL.active()) {
                if (!NATIVE_INPUT_TRIAL.owns(source)) { trace("native input unrelated nlp ignored"); return; }
                if (!nativeTrialBackgroundDisplay) nativeTrialTemplate = response;
                trace("native input official reply held");
                return;
            }
            try {
                String session = str(get(response, "SessionId"));
                boolean eligible = "chat".equals(get(response, "Domain")) && "chat".equals(get(response, "Intent"))
                    && "workflow".equals(get(response, "Sub")) && !Boolean.TRUE.equals(get(response, "Offline")) && get(response, "Command") == null;
                if (mode() != 0) trace("nlp eligible=" + eligible + " owned=" + TURN.owns(source, session)
                    + " command=" + (get(response, "Command") != null) + " offline=" + Boolean.TRUE.equals(get(response, "Offline"))
                    + " sameFinalSource=" + (source == previousFinalSource)
                    + " sameFinalSession=" + (previousFinalSession != null && previousFinalSession.equals(session)));
                if (mode() != 0 && eligible) {
                    if (TURN.owns(source, session)) return;
                    long generation = TURN.beginReply(source, session);
                    if (generation >= 0) {
                        String question = TURN.question(), sid = TURN.session();
                        startReply(generation, source, response, question, sid, mode() == 2);
                        return;
                    }
                }
                if (!eligible && TURN.owns(source, session)) {
                    trace("paseo cancelled: official skill superseded same turn"); cancel();
                    status = "本轮切回雷鸟官方技能，Paseo 回复未送到镜片";
                }
                original(source, "onNlpResult", new Class<?>[]{response.getClass()}, response);
            } catch (Exception failure) { status = "回复模板未通过检查，停止接管"; cancel();
                try { original(source, "onNlpResult", new Class<?>[]{response.getClass()}, response); } catch (Exception ignored) {} }
        });
    }
    public static void dispatchComplete(Object source) {
        serial(() -> {
            if (SettingsRecovery.paused()) return;
            if (nativeInputComplete(source)) return;
            if (source == completedSource) return;
            if (mode() != 0 && TURN.owns(source, "")) return;
            try { original(source, "onResponseComplete", new Class<?>[]{}); } catch (Exception failure) { status = "官方完成回调失败"; }
        });
    }
    private static void startReply(long generation, Object source, Object template, String question, String session, boolean paseo) {
        replySource = source; replyTemplate = template;
        final InteractionPreferences preferences = NATIVE_INPUT_TRIAL.owns(source) ? NATIVE_INPUT_TRIAL.preferences()
            : interactionSettings == null ? InteractionPreferences.defaults() : interactionSettings.current();
        replyPreferences = preferences;
        finalizer = new TurnFinalizer(() -> original(source, "onResponseComplete", new Class<?>[]{}));
        displayed = new DisplayChunks();
        final ShortcutBindings.Entry shortcut = NATIVE_INPUT_TRIAL.owns(source) ? NATIVE_INPUT_TRIAL.shortcut()
            : activeShortcuts() == null ? null : activeShortcuts().current().match(question);
        String readingPage = ANSWER_BROWSER.route(question);
        if (readingPage != null) {
            trace("reading local=true chars=" + readingPage.length());
            MAIN.post(() -> emit(generation, readingPage, "browse"));
            return;
        }
        if (paseo && ConnectionProfiles.MIKA.equals(ConnectionProfiles.active(settingsValues()))) {
            if (VoiceCommand.isModeQuery(question)) MAIN.post(() -> emit(generation, currentModeText()));
            else {
                final String mikaSession = mikaGlassesSession;
                NETWORK.execute(() -> requestMika(generation, question, mikaSession));
            }
            MAIN.postDelayed(() -> emit(generation, "等待超时，请在手机上查看任务，不要重复发送。"), 450000);
            return;
        }
        if (shortcut != null) {
            if (!paseo)
                MAIN.post(() -> emit(generation, "请先切换到 Paseo 或 Codex 模式，再使用快捷方式。", "control"));
            else {
                ConnectionProfiles.Profile profile = activeConnection();
                NETWORK.execute(() -> requestShortcut(generation, shortcut, session, profile));
            }
        }
        else if (VoiceCommand.isModeQuery(question)) MAIN.post(() -> emit(generation, currentModeText()));
        else if (!paseo) MAIN.postDelayed(() -> emit(generation, "本地回显：" + question), 400);
        else {
            ConnectionProfiles.Profile profile = activeConnection();
            status = "正在等待 " + ConnectionProfiles.label(ConnectionProfiles.active(settingsValues())) + " 回复，最多约 5 分钟";
            NETWORK.execute(() -> request(generation, question, session, profile, preferences));
        }
        MAIN.postDelayed(() -> emit(generation, "等待超时，请查看 Paseo 原会话，不要重复发送。"), 450000);
    }
    private static MikaTaskCoordinator mikaCoordinator() throws Exception {
        if (mikaCoordinator != null) return mikaCoordinator;
        MikaCredentials credentials = new MikaCredentials(app);
        MikaRemote remote = new MikaRemote(new MikaLocalHttp(credentials.port(), credentials.token()));
        final SharedPreferences task = app.getSharedPreferences("rayneo_paseo_mika_task", Context.MODE_PRIVATE);
        mikaCoordinator = new MikaTaskCoordinator(new MikaTaskCoordinator.Store() {
            public String read() { return task.getString("task_id", ""); }
            public boolean save(String id) { return task.edit().putString("task_id", id).commit(); }
        }, remote, () -> java.util.UUID.randomUUID().toString());
        return mikaCoordinator;
    }
    private static void requestMika(long generation, String question, String session) {
        try {
            MikaTaskCoordinator coordinator = mikaCoordinator();
            String beforeRefresh = coordinator.taskId();
            String refreshNotice = coordinator.refresh();
            if (!beforeRefresh.isEmpty() && coordinator.taskId().isEmpty()) {
                MAIN.post(() -> emit(generation, refreshNotice)); return;
            }
            String previousTask = coordinator.taskId();
            MikaCredentials credentials = new MikaCredentials(app);
            MikaRemote progressRemote = new MikaRemote(new MikaLocalHttp(credentials.port(), credentials.token()));
            MikaProgress progress = new MikaProgress();
            if (!previousTask.isEmpty()) {
                try { progressRemote.readProgress(previousTask, progress); progress.take(); }
                catch (Exception unavailable) { trace("Mika progress temporarily unavailable"); }
            }
            String reply = coordinator.send(question, session);
            if (reply.contains("不要重复发送") || reply.contains("未发送") || reply.contains("手机上处理") || reply.startsWith("上一段对话的手机任务")) {
                final String result = reply; MAIN.post(() -> emit(generation, result)); return;
            }
            if (coordinator.isProgress() && !reply.isEmpty()) { final String update = reply; MAIN.post(() -> showMikaProgress(generation, update)); }
            if (!previousTask.equals(coordinator.taskId())) progress = new MikaProgress();
            long deadline = android.os.SystemClock.elapsedRealtime() + 240000;
            while (TURN.accepts(generation) && !coordinator.needsUserOrFinished() && android.os.SystemClock.elapsedRealtime() < deadline) {
                Thread.sleep(2000);
                String next = coordinator.refresh();
                try {
                    progressRemote.readProgress(coordinator.taskId(), progress);
                    for (String step : progress.take()) {
                        final String update = step;
                        MAIN.post(() -> showMikaProgress(generation, update));
                        Thread.sleep(1000);
                    }
                } catch (InterruptedException interrupted) { throw interrupted; }
                catch (Exception unavailable) { trace("Mika progress temporarily unavailable"); }
                if (!next.isEmpty()) {
                    reply = next;
                    if (coordinator.isProgress()) { final String update = next; MAIN.post(() -> showMikaProgress(generation, update)); }
                }
            }
            if (!coordinator.needsUserOrFinished()) reply = "任务仍在执行，请稍后在手机上查看。";
            final String result = reply; MAIN.post(() -> emit(generation, result));
        } catch (Exception failure) {
            MAIN.post(() -> emit(generation, "连接或任务状态无法确认，请检查手机，不要重复发送。"));
        }
    }
    private static void showMikaProgress(long generation, String text) {
        if (!TURN.accepts(generation) || replySource == null || replyTemplate == null || finalizer == null) return;
        try {
            original(replySource, "onNlpResult", new Class<?>[]{replyTemplate.getClass()}, copy(replyTemplate, text + "\n", false));
        }
        catch (Exception failure) { trace("Mika progress display failed"); }
    }
    private static Object copy(Object source, String answer, boolean finished) throws Exception {
        Object result = source.getClass().getConstructor().newInstance();
        for (String field : new String[]{"Sub", "DialogId", "SessionId", "Domain", "Intent", "Round", "Query", "HasNextRound", "Offline", "RawData"}) {
            Method getter = source.getClass().getMethod("get" + field);
            source.getClass().getMethod("set" + field, getter.getReturnType()).invoke(result, getter.invoke(source));
        }
        source.getClass().getMethod("setAnswer", String.class).invoke(result, answer);
        source.getClass().getMethod("setSpoken", String.class).invoke(result, "");
        source.getClass().getMethod("setFinished", boolean.class).invoke(result, finished);
        return result;
    }
    private static void showProgress(long generation, ReplyProgress progress, String state) {
        if (!TURN.accepts(generation) || replySource == null || replyTemplate == null || finalizer == null) return;
        String label = progress.state(state);
        if (label.isEmpty()) return;
        // The stock lens app appends chunks. Keep these outside DisplayChunks
        // and ANSWER_BROWSER so full-answer reconciliation and browsing stay clean.
        String notice = ("tool".equals(state) ? "\n" : "") + label + "\n";
        try {
            original(replySource, "onNlpResult", new Class<?>[]{replyTemplate.getClass()}, copy(replyTemplate, notice, false));
        } catch (Exception failure) { trace("preview delivered=false"); }
    }
    private static void showPreview(long generation, String snapshot) {
        if (!TURN.accepts(generation) || replySource == null || replyTemplate == null || finalizer == null) return;
        String delta = displayed.preview(snapshot);
        if (delta == null) return;
        try {
            original(replySource, "onNlpResult", new Class<?>[]{replyTemplate.getClass()}, copy(replyTemplate, delta, false));
            displayed.previewDelivered(snapshot);
            trace("preview delivered=true chars=" + delta.length());
        } catch (Exception failure) { trace("preview delivered=false"); }
    }
    private static void emit(long generation, String text) {
        emit(generation, text, "local");
    }
    private static void emit(long generation, String text, String outcome) {
        emit(generation, text, outcome, null);
    }
    private static void emit(long generation, String text, String outcome, ReplyProgress progress) {
        if (!TURN.accepts(generation) || replySource == null || replyTemplate == null || finalizer == null) return;
        if (!"idle".equals(outcome)) text = replyPreferences.localize(text);
        if (text.length() > 8192) { int end = Character.isHighSurrogate(text.charAt(8191)) ? 8191 : 8192; text = text.substring(0, end) + "\n完整回复请在原客户端查看。"; }
        String delta = displayed.finalChunk(text);
        String completion = progress == null ? "" : progress.finish(outcome);
        final String answer = delta + (completion.isEmpty() ? "" : (delta.endsWith("\n") ? "" : "\n") + completion);
        final TurnFinalizer ending = finalizer;
        final Object owner = replySource, template = replyTemplate;
        if (mode() == 3 && NATIVE_INPUT_TRIAL.owns(owner) && NATIVE_INPUT_TRIAL.replyStarted()) {
            boolean delivered = ending.deliver(() -> original(owner, "onNlpResult", new Class<?>[]{template.getClass()}, copy(template, answer, true)));
            if (delivered) ANSWER_BROWSER.completed(TURN.question(), text, outcome);
            TURN.complete(generation);
            if (delivered && completedReplyObserver != null) {
                try {
                    if (completedReplyObserver.completed(owner, TURN.question(), text, outcome)) {
                        trace("display delivered=true chars=" + answer.length() + " readingHandoff=true");
                        return;
                    }
                } catch (Exception failure) { trace("completed reply observer failed"); }
            }
            trace("display delivered=" + delivered + " chars=" + answer.length() + " keepListening=true");
            if (delivered) {
                try { resumeNativeConversation(owner, template); }
                catch (Exception failure) { endNativeInputTrial("resume_failed", true); status = "继续收音失败，请重新唤醒"; }
            } else endNativeInputTrial("display_failed", true);
            return;
        }
        boolean delivered = ending.finish(() -> original(owner, "onNlpResult", new Class<?>[]{template.getClass()}, copy(template, answer, true)));
        if (delivered) ANSWER_BROWSER.completed(TURN.question(), text, outcome);
        TURN.complete(generation);
        if (!ending.isClosed()) TURN.release(generation);
        else completedSource = owner;
        status = delivered ? "回复已交给官方显示回调，待镜片确认" : "回复回调失败，已尝试收尾";
        trace("display delivered=" + delivered + " chars=" + answer.length());
        if (NATIVE_INPUT_TRIAL.owns(owner) && NATIVE_INPUT_TRIAL.replyStarted()) endNativeInputTrial("replied", false);
    }
    private static SSLContext localTls() throws Exception {
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null, null);
        try (InputStream certificate = app.getAssets().open("rayneo-paseo-local.cer")) {
            store.setCertificateEntry("local", CertificateFactory.getInstance("X.509").generateCertificate(certificate));
        }
        TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trust.init(store);
        SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, trust.getTrustManagers(), null); return tls;
    }
    private static HttpsURLConnection openBridge(ConnectionProfiles.Profile profile) throws Exception {
        return openBridge(profile, false);
    }
    private static HttpsURLConnection openBridge(ConnectionProfiles.Profile profile, boolean handshake) throws Exception {
        java.net.URL url = BridgeEndpoint.resolve(profile.endpoint, profile.port);
        if (handshake) url = new java.net.URL(url.toString().replaceFirst("/v1/chat/completions$", "/v1/navigation/session"));
        return openBridgeUrl(url, profile);
    }
    private static HttpsURLConnection openBridgeUrl(java.net.URL url, ConnectionProfiles.Profile profile) throws Exception {
        HttpsURLConnection http = PinnedTls.open(url, profile.certificateSha256);
        // Explicit legacy USB profiles retain their original local certificate. Paired identities never fall back.
        if (profile.certificateSha256.isEmpty() && BridgeEndpoint.useLocalCertificate(url)) http.setSSLSocketFactory(localTls().getSocketFactory());
        http.setInstanceFollowRedirects(false);
        return http;
    }
    private static String checkConnectionHealth(ConnectionProfiles.Profile profile) {
        HttpsURLConnection http = null;
        try {
            http = openBridgeUrl(BridgeEndpoint.healthEndpoint(profile.endpoint, profile.port), profile);
            http.setConnectTimeout(3000); http.setReadTimeout(5000); http.setRequestMethod("GET");
            http.setRequestProperty("Authorization", "Bearer " + profile.token);
            int code = http.getResponseCode();
            String healthState = "";
            InputStream stream = code >= 400 ? http.getErrorStream() : http.getInputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] bytes = new byte[2049]; int size = 0, count;
                while (size < bytes.length && (count = input.read(bytes, size, bytes.length - size)) != -1) size += count;
                if (size < bytes.length) {
                    try { healthState = new JSONObject(new String(bytes, 0, size, StandardCharsets.UTF_8)).optString("status", ""); }
                    catch (Exception ignored) { /* Never display raw proxy responses. */ }
                }
            }
            trace("connection health http=" + code);
            return BridgeEndpoint.healthMessage(code, healthState);
        } catch (Exception failure) {
            trace("connection health unavailable");
            return BridgeEndpoint.healthMessage(0, "");
        } finally { if (http != null) http.disconnect(); }
    }
    private static NavigationSession.Store navigationStore() {
        return new NavigationSession.Store() {
            public Map<String, ?> read() { return ConnectionSecrets.read(settings.getAll(), AndroidSecrets.envelope()); }
            public boolean commit(Map<String, Object> changes) {
                Map<String, Object> protectedChanges = ConnectionSecrets.protectChanges(settings.getAll(), changes, AndroidSecrets.envelope());
                SharedPreferences.Editor editor = settings.edit();
                for (Map.Entry<String, Object> entry : protectedChanges.entrySet()) {
                    Object value = entry.getValue();
                    if (value == null) editor.remove(entry.getKey());
                    else if (value instanceof Integer) editor.putInt(entry.getKey(), (Integer)value);
                    else if (value instanceof Long) editor.putLong(entry.getKey(), (Long)value);
                    else if (value instanceof String) editor.putString(entry.getKey(), (String)value);
                    else if (value instanceof Boolean) editor.putBoolean(entry.getKey(), (Boolean)value);
                    else throw new IllegalStateException("导航设置类型无效");
                }
                return editor.commit();
            }
        };
    }
    private static JSONObject navigationPost(ConnectionProfiles.Profile profile, JSONObject body, NavigationSession.Snapshot snapshot,
                                             boolean tracked, java.util.function.BooleanSupplier accepts) throws Exception {
        return NavigationTransport.exchange(BridgeEndpoint.resolve(profile.endpoint, profile.port), () -> {
            if (!NAVIGATION.isCurrent(snapshot) || !accepts.getAsBoolean()) throw new IllegalStateException("导航会话已变化或请求已取消");
        }, (connectTimeout, readTimeout, attempt) -> {
          HttpsURLConnection http = openBridge(profile, true);
          long started = android.os.SystemClock.elapsedRealtime();
          try {
            trace("navigation handshake attempt=" + attempt + " readTimeoutMs=" + readTimeout);
            http.setConnectTimeout(connectTimeout); http.setReadTimeout(readTimeout); http.setRequestMethod("POST"); http.setDoOutput(true);
            http.setRequestProperty("Content-Type", "application/json"); http.setRequestProperty("Authorization", "Bearer " + profile.token);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); http.setFixedLengthStreamingMode(bytes.length);
            if (tracked) connection = http;
            try (OutputStream output = http.getOutputStream()) { output.write(bytes); }
            if (http.getResponseCode() != 200) throw new IllegalStateException("导航握手未完成");
            StringBuilder result = new StringBuilder();
            try (BufferedReader input = new BufferedReader(new InputStreamReader(http.getInputStream(), StandardCharsets.UTF_8))) {
                String line; while ((line = input.readLine()) != null) { result.append(line); if (result.length() > 4096) throw new java.io.IOException(); }
            }
            if (!NAVIGATION.isCurrent(snapshot)) throw new IllegalStateException("导航会话已变化");
            return new JSONObject(result.toString());
          } catch (Exception failure) {
            trace("navigation handshake failed cause=" + failure.getClass().getSimpleName().replaceAll("[^A-Za-z]", "")
                + " elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started));
            throw failure;
          } finally { if (tracked && connection == http) connection = null; http.disconnect(); }
        });
    }
    private static JSONObject bindNavigation(ConnectionProfiles.Profile profile, NavigationSession.Snapshot snapshot) throws Exception {
        return bindNavigation(profile, snapshot, true);
    }
    private static JSONObject bindNavigation(ConnectionProfiles.Profile profile, NavigationSession.Snapshot snapshot, boolean tracked) throws Exception {
        return bindNavigation(profile, snapshot, tracked, () -> true);
    }
    private static JSONObject bindNavigation(ConnectionProfiles.Profile profile, NavigationSession.Snapshot snapshot,
                                            boolean tracked, java.util.function.BooleanSupplier accepts) throws Exception {
        JSONObject identity = new JSONObject().put("action", "challenge").put("installationId", snapshot.installationId).put("epoch", snapshot.epoch);
        JSONObject response = navigationPost(profile, identity, snapshot, tracked, accepts);
        if (!response.has("binding")) {
            identity.put("action", "bind").put("challenge", response.getString("challenge"));
            response = navigationPost(profile, identity, snapshot, tracked, accepts);
        }
        JSONObject binding = response.getJSONObject("binding");
        for (String key : new String[]{"sessionToken", "generation"}) {
            if (!binding.getString(key).matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")) throw new IllegalStateException("导航响应无效");
        }
        if (!ConnectionProfiles.active(settingsValues()).equals(binding.getString("backend")) || !NAVIGATION.isCurrent(snapshot)) throw new IllegalStateException("导航连接已变化");
        return binding;
    }
    private static JSONObject shortcutTarget(ShortcutBindings.Entry entry) throws Exception {
        JSONObject target = new JSONObject().put("kind", entry.kind).put("serverId", entry.serverId).put("workspaceId", entry.workspaceId);
        if ("agent".equals(entry.kind)) target.put("agentId", entry.agentId);
        return target;
    }
    private static final class ShortcutFailure extends Exception {
        ShortcutFailure(String message) { super(message); }
    }
    private static JSONObject shortcutPost(ConnectionProfiles.Profile profile, String action, JSONObject body, JSONObject binding,
                                           NavigationSession.Snapshot snapshot, String requestId, boolean tracked, long generation) throws Exception {
        if (!BackendCapabilities.accepts(ConnectionProfiles.active(settingsValues()), binding.optString("backend"), binding.optBoolean("shortcuts", false)))
            throw new ShortcutFailure("当前电脑入口不支持快捷方式，请更新电脑接入服务；本次未切换。");
        java.net.URL base = BridgeEndpoint.resolve(profile.endpoint, profile.port);
        HttpsURLConnection http = openBridgeUrl(new java.net.URL(base.toString().replaceFirst("/v1/chat/completions$", "/v1/shortcuts/" + action)), profile);
        try {
            http.setConnectTimeout(3000); http.setReadTimeout(15000); http.setRequestMethod("POST"); http.setDoOutput(true);
            http.setRequestProperty("Content-Type", "application/json"); http.setRequestProperty("Authorization", "Bearer " + profile.token);
            http.setRequestProperty("Idempotency-Key", requestId); navigationHeaders(http, binding, snapshot);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); http.setFixedLengthStreamingMode(bytes.length);
            if (tracked) connection = http;
            if (tracked && !TURN.accepts(generation)) throw new ShortcutFailure("本次快捷切换已取消。");
            try (OutputStream output = http.getOutputStream()) { output.write(bytes); }
            int code = http.getResponseCode();
            if (code != 200) throw new ShortcutFailure(bridgeFailure(http, code));
            StringBuilder value = new StringBuilder();
            try (BufferedReader input = new BufferedReader(new InputStreamReader(http.getInputStream(), StandardCharsets.UTF_8))) {
                String line; while ((line = input.readLine()) != null) { value.append(line); if (value.length() > 16384) throw new java.io.IOException(); }
            }
            if (!NAVIGATION.isCurrent(snapshot)) throw new ShortcutFailure("连接已变化，请重新核对快捷目标。");
            return new JSONObject(value.toString());
        } finally { if (tracked && connection == http) connection = null; http.disconnect(); }
    }
    private static void resolveShortcutTarget(String kind, String seed, ShortcutBindings.Entry existing, ShortcutSettingsUi.Callback callback) {
        final NavigationSession.Snapshot snapshot = NAVIGATION.current();
        final ConnectionProfiles.Profile profile = activeConnection();
        final String backend = ConnectionProfiles.active(settingsValues());
        HEALTH_NETWORK.execute(() -> {
            try {
                JSONObject body;
                if (!seed.isEmpty()) body = new JSONObject().put("kind", kind).put("agentId", seed);
                else if (existing != null && existing.kind.equals(kind)) body = new JSONObject().put("target", shortcutTarget(existing));
                else body = new JSONObject().put("kind", kind).put("useCurrent", true);
                JSONObject binding = bindNavigation(profile, snapshot, false);
                JSONObject target = shortcutPost(profile, "resolve", body, binding, snapshot, "resolve-" + UUID.randomUUID(), false, -1).getJSONObject("target");
                ShortcutBindings.Entry resolved = new ShortcutBindings.Entry("resolved", "", target.getString("kind"), target.getString("serverId"),
                    target.getString("workspaceId"), target.optString("agentId", ""), target.getString("workspaceName"), target.optString("agentName", ""));
                MAIN.post(() -> callback.ready(resolved, () -> {
                    if (!NAVIGATION.isCurrent(snapshot) || !backend.equals(ConnectionProfiles.active(settingsValues())))
                        throw new IllegalStateException("连接已变化，请重新核对快捷目标。");
                }));
            } catch (Exception failure) {
                String message = failure instanceof ShortcutFailure ? failure.getMessage() : "快捷目标未能核对，请检查连接和 Agent ID 后重试。";
                MAIN.post(() -> callback.failed(message));
            }
        });
    }
    private static void requestShortcut(long generation, ShortcutBindings.Entry shortcut, String session, ConnectionProfiles.Profile profile) {
        String answer = "快捷切换未确认，请检查连接并说当前 Agent 或当前项目核对。";
        boolean applied = false;
        try {
            if (!TURN.accepts(generation)) return;
            NavigationSession.Snapshot snapshot = NAVIGATION.current();
            JSONObject binding = bindNavigation(profile, snapshot, true, () -> TURN.accepts(generation));
            if (!TURN.accepts(generation)) return;
            String requestId = "shortcut-" + UUID.randomUUID();
            JSONObject result = shortcutPost(profile, "select", new JSONObject().put("target", shortcutTarget(shortcut)), binding, snapshot, requestId, true, generation);
            if (!"control".equals(result.optString("status"))) throw new java.io.IOException();
            answer = result.getString("text"); applied = result.optBoolean("shortcutApplied", false);
            trace("shortcut control completed applied=" + applied);
        } catch (Exception failure) {
            trace("shortcut control failed");
            if (failure instanceof ShortcutFailure) answer = failure.getMessage();
        }
        final String text = answer; final boolean changed = applied;
        MAIN.post(() -> {
            if (!TURN.accepts(generation)) return;
            if (changed) ANSWER_BROWSER.clear();
            emit(generation, text, "control");
        });
    }
    private static void navigationHeaders(HttpsURLConnection http, JSONObject binding, NavigationSession.Snapshot snapshot) throws Exception {
        if (!NAVIGATION.isCurrent(snapshot)) throw new IllegalStateException("导航会话已变化");
        http.setRequestProperty("X-Navigation-Owner", snapshot.installationId);
        http.setRequestProperty("X-Navigation-Epoch", Long.toString(snapshot.epoch));
        http.setRequestProperty("X-Navigation-Session", binding.getString("sessionToken"));
        http.setRequestProperty("X-Navigation-Generation", binding.getString("generation"));
    }
    private static String bridgeFailure(HttpsURLConnection http, int code) {
        String errorCode = "";
        try (InputStream stream = http.getErrorStream()) {
            if (stream != null) {
                InputStreamReader reader = new InputStreamReader(stream, StandardCharsets.UTF_8);
                char[] bytes = new char[8193]; int size = 0, count;
                while (size < bytes.length && (count = reader.read(bytes, size, bytes.length - size)) != -1) size += count;
                if (size < bytes.length) {
                    JSONObject error = new JSONObject(new String(bytes, 0, size)).optJSONObject("error");
                    if (error != null) errorCode = error.optString("code", "");
                }
            }
        } catch (Exception ignored) { /* Show only fixed status text, never raw proxy errors. */ }
        if (errorCode.startsWith("NAVIGATION_")) return "导航会话已变化，本次未发送。请重新列出名单。";
        if ("SHORTCUT_HOST_CHANGED".equals(errorCode)) return "快捷方式属于另一台 Paseo 主机，本次未切换。请重新绑定。";
        if ("SHORTCUT_TARGET_UNAVAILABLE".equals(errorCode)) return "快捷目标已不可用，本次未切换。请在手机重新绑定。";
        if ("SHORTCUT_UNSUPPORTED".equals(errorCode)) return "当前电脑入口不支持快捷方式，请更新电脑接入服务；本次未切换。";
        return BridgeEndpoint.failureMessage(code, errorCode);
    }
    private static void request(long generation, String question, String session, ConnectionProfiles.Profile profile, InteractionPreferences preferences) {
        HttpsURLConnection http = null;
        boolean mayHaveBeenSent = false;
        String answer = null;
        String outcome = "unknown";
        final ReplyProgress progress = ReplyProgress.forBackend(ConnectionProfiles.active(settingsValues()),
            VoiceCommand.isSearch(question), VoiceCommand.isCreate(question), preferences);
        long started = android.os.SystemClock.elapsedRealtime();
        try {
            if (!TURN.accepts(generation)) return;
            if (profile.token.isEmpty()) throw new IllegalArgumentException();
            NavigationSession.Snapshot navigation = NAVIGATION.current();
            JSONObject binding = bindNavigation(profile, navigation, true, () -> TURN.accepts(generation));
            if (VoiceCommand.creationBlocked(question, binding.optBoolean("agentCreation", false))) {
                answer = "当前电脑入口不支持语音新建，本次未创建。请更新电脑接入服务。";
                outcome = "control";
                trace("creation unsupported blocked=true");
                return;
            }
            if (VoiceCommand.searchBlocked(question, binding.optBoolean("conversationSearch", false))) {
                answer = "当前电脑入口不支持查找对话，本次未发送。请更新电脑接入服务。";
                outcome = "control";
                trace("search unsupported blocked=true");
                return;
            }
            http = openBridge(profile);
            navigationHeaders(http, binding, navigation);
            http.setConnectTimeout(8000); http.setReadTimeout(315000); http.setRequestMethod("POST"); http.setDoOutput(true);
            http.setRequestProperty("Content-Type", "application/json"); http.setRequestProperty("Authorization", "Bearer " + profile.token);
            byte[] hash = MessageDigest.getInstance("SHA-256").digest((session + "\n" + question).getBytes(StandardCharsets.UTF_8));
            StringBuilder id = new StringBuilder(); for (byte value : hash) id.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            http.setRequestProperty("Idempotency-Key", id.toString());
            byte[] bytes = new JSONObject().put("stream", true).put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", question))).toString().getBytes(StandardCharsets.UTF_8);
            http.setFixedLengthStreamingMode(bytes.length); connection = http;
            if (!TURN.accepts(generation)) return;
            mayHaveBeenSent = true;
            try (OutputStream output = http.getOutputStream()) { output.write(bytes); }
            int code = http.getResponseCode(); trace("bridge http=" + code);
            if (code != 200) { answer = bridgeFailure(http, code); return; }
            int total = 0;
            try (BufferedReader input = new BufferedReader(new InputStreamReader(http.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    total += line.length();
                    if (line.length() > 65536 || total > 1048576) throw new java.io.IOException();
                    JSONObject frame = new JSONObject(line);
                    String type = frame.optString("type", "");
                    if ("state".equals(type)) {
                        String state = frame.optString("state", "");
                        MAIN.post(() -> showProgress(generation, progress, state));
                    } else if ("text".equals(type)) {
                        String partial = frame.optString("text", "");
                        MAIN.post(() -> showPreview(generation, partial));
                    } else if ("done".equals(type)) {
                        answer = frame.getString("text");
                        outcome = frame.optString("status", "unknown");
                        trace("bridge outcome=" + outcome.replaceAll("[^a-z]", "") + " chars=" + answer.length());
                        break;
                    }
                }
            }
            if (answer == null) throw new java.io.IOException();
        } catch (Exception failure) { trace("bridge request failed"); answer = BridgeEndpoint.connectionFailure(mayHaveBeenSent); }
        finally {
            trace("bridge elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started));
            if (http != null) { if (connection == http) connection = null; http.disconnect(); }
            if (answer != null) { final String result = answer, finalOutcome = outcome;
                MAIN.post(() -> emit(generation, result, finalOutcome, progress)); }
        }
    }
    private static void requestContinuous(long generation, String question, String session, ConnectionProfiles.Profile profile) {
        HttpsURLConnection http = null;
        boolean mayHaveBeenSent = false;
        String answer = null;
        long started = android.os.SystemClock.elapsedRealtime();
        try {
            if (!continuousAccepts(generation)) return;
            if (profile.token.isEmpty()) throw new IllegalArgumentException();
            NavigationSession.Snapshot navigation = NAVIGATION.current();
            JSONObject binding = bindNavigation(profile, navigation, true, () -> continuousAccepts(generation));
            if (VoiceCommand.creationBlocked(question, binding.optBoolean("agentCreation", false))) {
                answer = "当前电脑入口不支持语音新建，本次未创建。请更新电脑接入服务。";
                trace("creation unsupported blocked=true");
                return;
            }
            if (VoiceCommand.searchBlocked(question, binding.optBoolean("conversationSearch", false))) {
                answer = "当前电脑入口不支持查找对话，本次未发送。请更新电脑接入服务。";
                trace("search unsupported blocked=true");
                return;
            }
            http = openBridge(profile);
            navigationHeaders(http, binding, navigation);
            http.setConnectTimeout(8000); http.setReadTimeout(315000); http.setRequestMethod("POST"); http.setDoOutput(true);
            http.setRequestProperty("Content-Type", "application/json");
            http.setRequestProperty("Authorization", "Bearer " + profile.token);
            byte[] hash = MessageDigest.getInstance("SHA-256").digest((session + "\n" + question).getBytes(StandardCharsets.UTF_8));
            StringBuilder id = new StringBuilder();
            for (byte value : hash) id.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            http.setRequestProperty("Idempotency-Key", id.toString());
            byte[] bytes = new JSONObject().put("stream", true).put("messages", new JSONArray().put(
                new JSONObject().put("role", "user").put("content", question))).toString().getBytes(StandardCharsets.UTF_8);
            http.setFixedLengthStreamingMode(bytes.length);
            connection = http;
            if (!continuousAccepts(generation)) return;
            mayHaveBeenSent = true;
            try (OutputStream output = http.getOutputStream()) { output.write(bytes); }
            int code = http.getResponseCode();
            trace("continuous bridge http=" + code);
            if (code != 200) { answer = bridgeFailure(http, code); return; }
            int total = 0;
            try (BufferedReader input = new BufferedReader(new InputStreamReader(http.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    total += line.length();
                    if (line.length() > 65536 || total > 1048576) throw new java.io.IOException();
                    JSONObject frame = new JSONObject(line);
                    String type = frame.optString("type", "");
                    if ("text".equals(type)) {
                        String partial = frame.optString("text", "");
                        MAIN.post(() -> continuousPreview(generation, partial));
                    } else if ("done".equals(type)) {
                        answer = frame.getString("text");
                        trace("continuous bridge outcome=" + frame.optString("status", "unknown").replaceAll("[^a-z]", "")
                            + " chars=" + answer.length());
                        break;
                    }
                }
            }
            if (answer == null) throw new java.io.IOException();
        } catch (Exception failure) {
            trace("continuous bridge request failed");
            answer = BridgeEndpoint.connectionFailure(mayHaveBeenSent);
        } finally {
            trace("continuous bridge elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started));
            if (http != null) { if (connection == http) connection = null; http.disconnect(); }
            if (answer != null) { final String result = answer; MAIN.post(() -> continuousFinish(generation, result)); }
        }
    }
}
