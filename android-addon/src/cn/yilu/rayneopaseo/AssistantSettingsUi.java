package cn.yilu.rayneopaseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.text.InputType;
import android.text.TextUtils;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Map;
import java.util.function.Supplier;

/** One mode, one visible set of actions. All configuration stays behind an explicit editor. */
final class AssistantSettingsUi {
    interface StatusCallback { void ready(String status); }
    interface Host {
        Map<String, ?> values();
        String blocked();
        void select(String mode);
        void save(String backend, ConnectionProfiles.Profile profile);
        void saveMika(int port, String token);
        int mikaPort();
        void check(String backend, StatusCallback callback);
        void pair(Runnable changed);
        void shortcuts();
        void commands(String backend);
        void prompts();
    }
    private final Activity activity;
    private final Host host;
    private final Context context;
    private final Dialog dialog;
    private final LinearLayout page;
    private final boolean dark;
    private final int surface, ink, muted, accent, selected, outline;
    private int generation;
    private AssistantSettingsUi(Activity activity, Host host) {
        this.activity = activity; this.host = host;
        dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        context = new ContextThemeWrapper(activity, dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        surface = dark ? 0xff111a18 : 0xfffafcfb;
        ink = dark ? 0xffe7efec : 0xff172d28;
        muted = dark ? 0xffb4c3bd : 0xff53675f;
        accent = dark ? 0xffacd8c7 : 0xff225c48;
        selected = dark ? 0xff28483c : 0xffdfefe6;
        outline = dark ? 0xff42564c : 0xffd4dfd8;
        dialog = new Dialog(context); dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        page = column(); page.setBackgroundColor(surface); page.setFitsSystemWindows(true);
        dialog.setContentView(page);
        dialog.setOnDismissListener(ignored -> generation++);
    }
    static void show(Activity activity, Host host) {
        AssistantSettingsUi ui = new AssistantSettingsUi(activity, host);
        ui.render(); ui.dialog.show();
        Window window = ui.dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(ui.surface));
            window.getDecorView().setPadding(0, 0, 0, 0);
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            window.setStatusBarColor(ui.surface); window.setNavigationBarColor(ui.surface);
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            if (!ui.dark) window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }
    static Context dialogContext(Activity activity) {
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        return new ContextThemeWrapper(activity, dark ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert);
    }
    static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    /** Keep the parent list alive. Cancel, Back and save on a child reveal exactly this level. */
    static AlertDialog choices(Activity activity, String title, Supplier<String[]> items, DialogInterface.OnClickListener selected) {
        Context context = dialogContext(activity);
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(context, android.R.layout.simple_list_item_1) {
            @Override public View getView(int position, View recycled, ViewGroup parent) {
                String value = getItem(position);
                int split = value.indexOf('\n');
                LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.VERTICAL);
                row.setPadding(dp(context, 24), dp(context, 14), dp(context, 24), dp(context, 14));
                row.setMinimumHeight(dp(context, split < 0 ? 52 : 76));
                row.setGravity(Gravity.CENTER_VERTICAL);
                TextView heading = new TextView(context); heading.setText(split < 0 ? value : value.substring(0, split));
                heading.setTextSize(17); heading.setTextColor(dark ? 0xffe7efec : 0xff172d28); row.addView(heading);
                if (split >= 0) {
                    TextView detail = new TextView(context); detail.setText(value.substring(split + 1));
                    detail.setTextSize(13); detail.setTextColor(dark ? 0xffb4c3bd : 0xff53675f);
                    detail.setPadding(0, dp(context, 4), 0, 0); detail.setMaxLines(2);
                    detail.setEllipsize(TextUtils.TruncateAt.END); row.addView(detail);
                }
                return row;
            }
        };
        adapter.addAll(items.get());
        AlertDialog dialog = new AlertDialog.Builder(context).setTitle(title).setAdapter(adapter, null)
            .setNegativeButton("返回", null).create();
        dialog.show();
        dialog.getListView().setDivider(new ColorDrawable(dark ? 0xff53615b : 0xffd4dfd8));
        dialog.getListView().setDividerHeight(dp(context, 1));
        dialog.getListView().setOnItemClickListener((parent, view, index, id) -> selected.onClick(dialog, index));
        dialog.getWindow().getDecorView().getViewTreeObserver().addOnWindowFocusChangeListener(focused -> {
            if (!focused || !dialog.isShowing()) return;
            int first = dialog.getListView().getFirstVisiblePosition();
            View top = dialog.getListView().getChildAt(0); int offset = top == null ? 0 : top.getTop();
            adapter.setNotifyOnChange(false); adapter.clear(); adapter.addAll(items.get()); adapter.notifyDataSetChanged();
            dialog.getListView().setSelectionFromTop(Math.min(first, Math.max(0, adapter.getCount() - 1)), offset);
        });
        return dialog;
    }
    private void render() {
        generation++; page.removeAllViews();
        String active = ConnectionProfiles.panelMode(host.values());
        LinearLayout bar = new LinearLayout(context); bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(24), dp(8), dp(12), dp(8));
        TextView title = text("助手设置", 22, ink); title.setTypeface(null, Typeface.BOLD);
        bar.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        Button close = textButton("关闭"); close.setOnClickListener(view -> dialog.dismiss()); bar.addView(close);
        page.addView(bar);
        ScrollView scroll = new ScrollView(context); scroll.setFillViewport(true);
        LinearLayout body = column(); body.setPadding(dp(24), dp(16), dp(24), dp(24)); scroll.addView(body);
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        Button pair = textButton("扫码配对电脑");
        pair.setOnClickListener(view -> host.pair(() -> { if (dialog.isShowing()) render(); }));
        body.addView(pair); space(body, 20);
        LinearLayout tabs = new LinearLayout(context); tabs.setPadding(dp(4), dp(4), dp(4), dp(4));
        tabs.setBackground(shape(surface, outline, 12));
        String[] ids = {ConnectionProfiles.PASEO, ConnectionProfiles.CODEX, ConnectionProfiles.MIKA, ConnectionProfiles.OFFICIAL};
        String[] labels = {"Paseo", "Codex", "Mika", "雷鸟官方"};
        for (int i = 0; i < ids.length; i++) {
            final String id = ids[i]; boolean chosen = active.equals(id);
            Button tab = textButton(labels[i]); tab.setTextSize(15); tab.setTextColor(chosen ? accent : muted);
            tab.setTypeface(null, chosen ? Typeface.BOLD : Typeface.NORMAL); tab.setSelected(chosen);
            tab.setBackground(touch(chosen ? selected : surface, 9));
            tab.setContentDescription(labels[i] + (chosen ? "，当前模式" : "，切换模式"));
            tabs.addView(tab, new LinearLayout.LayoutParams(0, -2, 1));
            tab.setOnClickListener(view -> {
                if (id.equals(ConnectionProfiles.panelMode(host.values()))) return;
                String blocked = host.blocked();
                if (!blocked.isEmpty()) { notice("暂时不能切换", blocked); return; }
                try { host.select(id); render(); }
                catch (IllegalArgumentException missing) {
                    if (ConnectionProfiles.MIKA.equals(id)) editMika();
                    else if (!ConnectionProfiles.OFFICIAL.equals(id)) notice("尚未配置", "请先在电脑连接器中准备 " + ConnectionProfiles.label(id) + "，再扫码配对电脑。");
                } catch (RuntimeException failure) { notice("切换未完成", failure.getMessage()); }
            });
        }
        body.addView(tabs); space(body, 28);
        if (ConnectionProfiles.OFFICIAL.equals(active)) {
            TextView heading = text("正在使用雷鸟官方", 20, ink); heading.setTypeface(null, Typeface.BOLD); body.addView(heading);
            TextView hint = text("按原来的方式唤醒眼镜即可使用。切回 Paseo 或 Codex 时，会保留你之前的设置。", 15, muted);
            hint.setPadding(0, dp(12), 0, 0); body.addView(hint);
            return;
        }
        if (ConnectionProfiles.MIKA.equals(active)) {
            TextView status = text("连接手机上的 Mika", 16, ink); body.addView(status);
            LinearLayout actions = new LinearLayout(context); Button check = textButton("检查连接"), edit = textButton("编辑参数");
            actions.addView(check); actions.addView(edit); body.addView(actions);
            final int expected = generation;
            check.setOnClickListener(view -> { check.setEnabled(false); status.setText("正在检查连接…");
                host.check(ConnectionProfiles.MIKA, result -> { if (dialog.isShowing() && expected == generation) { status.setText(result); check.setEnabled(true); } }); });
            edit.setOnClickListener(view -> editMika());
            body.addView(text("在 Mika 的连接电脑设置中开启网络访问，复制访问令牌后粘贴到这里。", 14, muted));
            return;
        }
        ConnectionProfiles.Profile activeProfile = ConnectionProfiles.load(host.values(), active);
        TextView status = text(activeProfile.token.isEmpty() ? "尚未配置，请扫码配对电脑" : "连接尚未检查", 16, ink);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); body.addView(status);
        LinearLayout actions = new LinearLayout(context); actions.setGravity(Gravity.START);
        Button check = textButton("检查连接"), edit = textButton("编辑参数"); actions.addView(check); actions.addView(edit); body.addView(actions);
        final int expected = generation;
        check.setOnClickListener(view -> {
            check.setEnabled(false); check.setText("检查中"); status.setText("正在检查连接…");
            host.check(active, result -> {
                if (!dialog.isShowing() || expected != generation) return;
                status.setText(result); check.setEnabled(true); check.setText("检查连接");
            });
        });
        edit.setOnClickListener(view -> editConnection(active, false));
        space(body, 24);
        TextView label = text("常用设置", 13, muted); label.setPadding(0, 0, 0, dp(8)); body.addView(label);
        row(body, "快捷方式", "用短语进入指定 Agent 或项目", () -> host.shortcuts());
        row(body, "语音口令", "修改确认、取消、切换等说法", () -> host.commands(active));
        row(body, "镜片提示", "调整进度状态和操作提示的文字", () -> host.prompts());
        space(body, 20);
        body.addView(text("语音口令和镜片提示在 Paseo、Codex 之间共用。", 13, muted));
    }
    private void editMika() {
        String blocked = host.blocked(); if (!blocked.isEmpty()) { notice("暂时不能编辑", blocked); return; }
        LinearLayout form = column(); form.setPadding(dp(24), dp(8), dp(24), dp(8));
        form.addView(text("Mika 本机端口", 14, ink));
        EditText port = input("默认 8765", String.valueOf(host.mikaPort()), false); port.setInputType(InputType.TYPE_CLASS_NUMBER); form.addView(port);
        form.addView(text("Mika 访问令牌", 14, ink)); EditText token = input("粘贴 Mika 访问令牌", "", true); form.addView(token);
        TextView error = text("", 14, dark ? 0xffffb4ab : 0xffa62924); form.addView(error);
        AlertDialog editor = new AlertDialog.Builder(context).setTitle("Mika 本机连接").setView(form).setNegativeButton("取消", null).setPositiveButton("保存并切换", null).create();
        editor.setOnShowListener(ignored -> editor.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try { host.saveMika(Integer.parseInt(port.getText().toString().trim()), token.getText().toString().trim()); editor.dismiss(); render(); }
            catch (Exception failure) { error.setText("请检查端口和访问令牌，尚未保存。"); }
        }));
        editor.show();
    }
    private void editConnection(String backend, boolean switching) {
        String blocked = host.blocked(); if (!blocked.isEmpty()) { notice("暂时不能编辑", blocked); return; }
        ConnectionProfiles.Profile profile = ConnectionProfiles.load(host.values(), backend);
        AlertDialog.Builder builder = new AlertDialog.Builder(context);
        LinearLayout form = column(); form.setPadding(dp(24), dp(8), dp(24), dp(8));
        TextView intro = text(switching ? "先完善连接参数，保存后切换到 " + ConnectionProfiles.label(backend) + "。" : "只修改 " + ConnectionProfiles.label(backend) + " 的连接参数。", 14, muted);
        form.addView(intro); space(form, 16);
        form.addView(text("HTTPS 地址", 14, ink));
        EditText address = input("https://域名/接入路径", profile.endpoint, false); address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); form.addView(address);
        boolean wirelessOnly;
        try (java.io.InputStream ignored = context.getAssets().open("rayneo-paseo-wireless-only")) { wirelessOnly = true; }
        catch (java.io.IOException missing) { wirelessOnly = false; }
        final boolean requiresWireless = wirelessOnly;
        form.addView(text(wirelessOnly ? "请使用电脑连接器扫码配对。" : "留空时通过 USB 连接电脑。", 13, muted)); space(form, 16);
        form.addView(text("接入令牌", 14, ink)); EditText token = input("填写此模式的接入令牌", profile.token, true); form.addView(token);
        CheckBox advanced = new CheckBox(context); advanced.setText("USB 调试参数"); advanced.setTextColor(muted); advanced.setMinHeight(dp(48)); form.addView(advanced);
        LinearLayout usb = column(); usb.addView(text("USB 端口", 14, ink)); EditText port = input("USB 端口", String.valueOf(profile.port), false);
        port.setInputType(InputType.TYPE_CLASS_NUMBER); usb.addView(port); form.addView(usb);
        advanced.setChecked(profile.endpoint.isEmpty()); usb.setVisibility(advanced.isChecked() ? View.VISIBLE : View.GONE);
        advanced.setOnCheckedChangeListener((button, checked) -> usb.setVisibility(checked ? View.VISIBLE : View.GONE));
        if (wirelessOnly) { advanced.setVisibility(View.GONE); usb.setVisibility(View.GONE); }
        TextView error = text("", 14, dark ? 0xffffb4ab : 0xffa62924); error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(error);
        ScrollView scroll = new ScrollView(context); scroll.addView(form);
        AlertDialog editor = builder.setTitle(ConnectionProfiles.label(backend) + " 连接参数").setView(scroll)
            .setNegativeButton("取消", null).setPositiveButton(switching ? "保存并切换" : "保存", null).create();
        editor.setOnShowListener(ignored -> editor.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                if (requiresWireless && address.getText().toString().trim().isEmpty()) throw new IllegalArgumentException();
                int number = Integer.parseInt(port.getText().toString().trim());
                host.save(backend, new ConnectionProfiles.Profile(address.getText().toString(), number, token.getText().toString()));
                editor.dismiss(); render();
            } catch (NumberFormatException invalid) { error.setText("USB 端口需填写 1024 至 65535 的整数。"); }
            catch (IllegalArgumentException invalid) { error.setText("请检查 HTTPS 地址、端口和接入令牌，尚未保存。"); }
            catch (RuntimeException failure) { error.setText(failure.getMessage()); }
        }));
        editor.show();
    }
    private EditText input(String hint, String value, boolean secret) {
        EditText input = new EditText(context); input.setTextSize(16); input.setSingleLine(true); input.setMinHeight(dp(56));
        input.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
        input.setHint(hint); input.setText(value); return input;
    }
    private void row(LinearLayout parent, String title, String subtitle, Runnable action) {
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(0, dp(16), 0, dp(16));
        row.setMinimumHeight(dp(72)); row.setBackground(touch(surface, 0)); row.setFocusable(true); row.setClickable(true);
        row.setContentDescription(title + "，" + subtitle); LinearLayout labels = column();
        TextView heading = text(title, 17, ink); labels.addView(heading); TextView detail = text(subtitle, 13, muted); detail.setPadding(0, dp(4), dp(8), 0); labels.addView(detail);
        row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1)); row.addView(new Chevron(context), new LinearLayout.LayoutParams(dp(24), dp(24)));
        row.setOnClickListener(view -> action.run()); parent.addView(row);
        View rule = new View(context); rule.setBackgroundColor(outline); parent.addView(rule, new LinearLayout.LayoutParams(-1, dp(1)));
    }
    private void notice(String title, String message) { new AlertDialog.Builder(context).setTitle(title).setMessage(message).setPositiveButton("知道了", null).show(); }
    private LinearLayout column() { LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL); return box; }
    private TextView text(String value, int size, int color) { TextView text = new TextView(context); text.setText(value); text.setTextSize(size); text.setTextColor(color); text.setLineSpacing(dp(3), 1); return text; }
    private Button textButton(String value) { Button button = new Button(context); button.setText(value); button.setAllCaps(false); button.setTextSize(14); button.setTextColor(accent); button.setMinWidth(dp(64)); button.setMinimumWidth(dp(64)); button.setMinHeight(dp(48)); button.setMinimumHeight(dp(48)); button.setPadding(dp(12), 0, dp(12), 0); button.setBackground(touch(surface, 8)); return button; }
    private GradientDrawable shape(int fill, int stroke, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(fill); shape.setCornerRadius(dp(radius)); if (stroke != 0) shape.setStroke(dp(1), stroke); return shape; }
    private RippleDrawable touch(int fill, int radius) { return new RippleDrawable(ColorStateList.valueOf(dark ? 0x33ffffff : 0x18225c48), shape(fill, 0, radius), shape(0xffffffff, 0, radius)); }
    private void space(LinearLayout parent, int height) { View space = new View(context); parent.addView(space, new LinearLayout.LayoutParams(1, dp(height))); }
    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private final class Chevron extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        Chevron(Context context) { super(context); setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); }
        protected void onDraw(Canvas canvas) { super.onDraw(canvas); paint.setStyle(Paint.Style.STROKE); paint.setColor(muted); paint.setStrokeWidth(dp(2)); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND); Path path = new Path(); path.moveTo(getWidth() * .4f, getHeight() * .3f); path.lineTo(getWidth() * .6f, getHeight() * .5f); path.lineTo(getWidth() * .4f, getHeight() * .7f); canvas.drawPath(path, paint); }
    }
}
