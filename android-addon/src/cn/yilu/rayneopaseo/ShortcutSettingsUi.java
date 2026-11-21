package cn.yilu.rayneopaseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.List;
import java.util.UUID;

/** Explicit metadata preview before saving. Opening or editing this screen cannot select an Agent. */
final class ShortcutSettingsUi {
    interface Callback { void ready(ShortcutBindings.Entry target, Runnable ensureCurrent); void failed(String message); }
    interface Resolver { String blocked(); void resolve(String kind, String seed, ShortcutBindings.Entry existing, Callback callback); }
    private ShortcutSettingsUi() {}
    private static RadioButton option(Context context, String label) {
        RadioButton button = new RadioButton(context); button.setId(View.generateViewId()); button.setText(label); return button;
    }
    private static void enabled(View view, boolean value) {
        view.setEnabled(value);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) enabled(group.getChildAt(i), value);
        }
    }
    static void show(Activity activity, ShortcutSettings settings, InteractionSettings vocabulary, Resolver resolver, Runnable saved, String backend) {
        if (!settings.valid()) {
            new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle("快捷方式配置无法读取")
                .setMessage("请清空快捷方式后重新配置。连接、口令、对话和未发送内容会保留。")
                .setNegativeButton("返回", null).setPositiveButton("清空快捷方式", (d, w) -> {
                    try { settings.restore(); saved.run(); show(activity, settings, vocabulary, resolver, saved, backend); }
                    catch (RuntimeException failure) { Toast.makeText(activity, failure.getMessage(), Toast.LENGTH_LONG).show(); }
                }).show(); return;
        }
        AssistantSettingsUi.choices(activity, "快捷方式", () -> {
            List<ShortcutBindings.Entry> entries = settings.current().entries();
            String[] labels = new String[entries.size() + 1];
            labels[0] = "新增快捷方式\n用一句短语绑定一个目标";
            for (int i = 0; i < entries.size(); i++) {
                ShortcutBindings.Entry entry = entries.get(i);
                labels[i + 1] = entry.phrases.replace('\n', '、') + "\n"
                    + ("workspace".equals(entry.kind) ? "工作区：" : "Agent：") + entry.targetName();
            }
            return labels;
        }, (d, index) -> {
            List<ShortcutBindings.Entry> entries = settings.current().entries();
            if (index == 0) edit(activity, settings, vocabulary, resolver, saved, null, backend);
            else if (index <= entries.size()) edit(activity, settings, vocabulary, resolver, saved, entries.get(index - 1), backend);
        });
    }
    private static void edit(Activity activity, ShortcutSettings settings, InteractionSettings vocabulary, Resolver resolver,
                             Runnable saved, ShortcutBindings.Entry existing, String backend) {
        AlertDialog.Builder builder = new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity));
        final boolean codex = "codex".equals(backend);
        LinearLayout box = new LinearLayout(builder.getContext()); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(AssistantSettingsUi.dp(builder.getContext(), 24), AssistantSettingsUi.dp(builder.getContext(), 12), AssistantSettingsUi.dp(builder.getContext(), 24), AssistantSettingsUi.dp(builder.getContext(), 12));
        TextView hint = new TextView(builder.getContext());
        hint.setText("唤醒后单独说完整短语即可切换。看到切换提示后再说正文。短语每行一个，最多 8 个。"); box.addView(hint);
        EditText phrases = new EditText(builder.getContext()); phrases.setHint("例如：记笔记\n随手记");
        phrases.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE); phrases.setMinLines(2);
        phrases.setText(existing == null ? "" : existing.phrases); box.addView(phrases);
        RadioGroup types = new RadioGroup(builder.getContext());
        RadioButton agent = new RadioButton(builder.getContext()); agent.setId(android.view.View.generateViewId()); agent.setText(codex ? "绑定指定对话（Agent）" : "绑定指定 Agent"); types.addView(agent);
        RadioButton workspace = new RadioButton(builder.getContext()); workspace.setId(android.view.View.generateViewId()); workspace.setText("绑定工作区（眼镜中的项目）"); types.addView(workspace);
        types.check(existing != null && "workspace".equals(existing.kind) ? workspace.getId() : agent.getId()); box.addView(types);
        RadioGroup sources = new RadioGroup(builder.getContext());
        RadioButton retain = existing == null ? null : option(builder.getContext(), "保留原绑定");
        RadioButton pasted = option(builder.getContext(), "粘贴 Codex 对话 ID");
        RadioButton current = option(builder.getContext(), "使用当前选中的对话或项目");
        if (codex) {
            TextView sourceLabel = new TextView(builder.getContext()); sourceLabel.setText("目标来源");
            sourceLabel.setPadding(0, AssistantSettingsUi.dp(builder.getContext(), 12), 0, 0); box.addView(sourceLabel);
            if (retain != null) sources.addView(retain);
            sources.addView(pasted); sources.addView(current); sources.check(retain == null ? pasted.getId() : retain.getId()); box.addView(sources);
        }
        TextView idHint = new TextView(builder.getContext());
        idHint.setText(codex ? "在手机 Codex 复制对话 ID，再回到这里粘贴。目标对话需要能在当前连接的电脑上找到。"
            : "从 Paseo 复制 Agent ID。绑定工作区时，填该工作区内任意一个 Agent 的 ID。已有工作区留空可保留原目标。"); box.addView(idHint);
        EditText seed = new EditText(builder.getContext()); seed.setHint(codex ? "Codex 对话 ID" : "粘贴 Agent ID"); seed.setSingleLine(true);
        seed.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        seed.setText(existing == null ? "" : existing.agentId);
        LinearLayout idRow = new LinearLayout(builder.getContext());
        idRow.addView(seed, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button paste = new Button(builder.getContext()); paste.setText("粘贴"); paste.setMinHeight(AssistantSettingsUi.dp(builder.getContext(), 48));
        if (codex) idRow.addView(paste); box.addView(idRow);
        TextView status = new TextView(builder.getContext()); status.setTextSize(14); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setVisibility(View.GONE); box.addView(status);
        Runnable updateSource = () -> {
            if (!codex) return;
            int selected = sources.getCheckedRadioButtonId();
            idRow.setVisibility(selected == pasted.getId() ? View.VISIBLE : View.GONE);
            idHint.setText(selected == pasted.getId() ? "在手机 Codex 复制对话 ID，再回到这里粘贴。目标对话需要能在当前连接的电脑上找到。"
                : selected == current.getId() ? "使用眼镜当前选中的目标。核对并保存后，会固定绑定到这个目标。"
                : "只修改短语，保留下面显示的原绑定。更换目标时请选择其他来源。");
        };
        sources.setOnCheckedChangeListener((group, selected) -> { updateSource.run(); status.setVisibility(View.GONE); });
        updateSource.run();
        paste.setOnClickListener(view -> {
            try {
                ClipboardManager clipboard = (ClipboardManager)activity.getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
                CharSequence text = clip == null || clip.getItemCount() != 1 ? null : clip.getItemAt(0).getText();
                if (text == null || text.length() > 4096) throw new IllegalArgumentException("请先在 Codex 复制对话 ID");
                String value = ShortcutTargetInput.resolve("id", text.toString(), "agent", null).seed;
                seed.setText(value); seed.setSelection(value.length()); status.setVisibility(View.GONE);
            } catch (RuntimeException failure) { status.setText(failure.getMessage() == null ? "无法粘贴，请长按输入框粘贴对话 ID" : failure.getMessage()); status.setVisibility(View.VISIBLE); }
        });
        if (existing != null) { TextView currentTarget = new TextView(builder.getContext()); currentTarget.setText("当前目标：" + existing.workspaceName
            + ("agent".equals(existing.kind) ? " / " + existing.agentName : "")); box.addView(currentTarget); }
        ScrollView scroll = new ScrollView(builder.getContext()); scroll.addView(box);
        AlertDialog dialog = builder.setTitle(existing == null ? "新增快捷方式" : "编辑快捷方式").setView(scroll)
            .setNegativeButton("取消", null).setPositiveButton("核对目标", null).create();
        if (existing != null) dialog.setButton(AlertDialog.BUTTON_NEUTRAL, "删除", (d, which) -> {});
        String rowId = existing == null ? UUID.randomUUID().toString() : existing.id;
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            final String words = phrases.getText().toString().trim();
            final String kind = types.getCheckedRadioButtonId() == workspace.getId() ? "workspace" : "agent";
            try {
                String blocked = resolver.blocked(); if (!blocked.isEmpty()) throw new IllegalStateException(blocked);
                ShortcutBindings.phrases(words, vocabulary.current());
                final String seedId;
                final ShortcutBindings.Entry previous;
                if (codex) {
                    int selected = sources.getCheckedRadioButtonId();
                    String source = selected == pasted.getId() ? "id" : selected == current.getId() ? "current" : "existing";
                    ShortcutTargetInput.Request request = ShortcutTargetInput.resolve(source, seed.getText().toString(), kind, existing == null ? null : existing.kind);
                    seedId = request.seed; previous = request.keepExisting ? existing : null;
                } else {
                    seedId = seed.getText().toString().trim(); previous = existing;
                }
                if (seedId.isEmpty() && !codex && (existing == null || !existing.kind.equals(kind))) throw new IllegalArgumentException("请填写 Agent ID");
                if (!seedId.isEmpty() && !seedId.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException("请只粘贴 Agent ID");
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                enabled(box, false); status.setText("正在核对目标…"); status.setVisibility(View.VISIBLE);
                resolver.resolve(kind, seedId, previous, new Callback() {
                    public void ready(ShortcutBindings.Entry target, Runnable ensureCurrent) {
                        if (!dialog.isShowing()) return;
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);
                        enabled(box, true); status.setVisibility(View.GONE);
                        ShortcutBindings.Entry candidate = new ShortcutBindings.Entry(rowId, words, target.kind, target.serverId,
                            target.workspaceId, target.agentId, target.workspaceName, target.agentName);
                        try { settings.current().with(candidate, vocabulary.current()); }
                        catch (RuntimeException error) { Toast.makeText(activity, error.getMessage(), Toast.LENGTH_LONG).show(); return; }
                        new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle("核对快捷目标")
                            .setMessage("短语：" + words.replace('\n', '、') + "\n工作区：" + target.workspaceName
                                + ("agent".equals(target.kind) ? "\nAgent：" + target.agentName : "\n进入后列出其中的 Agent")
                                + (codex && "agent".equals(target.kind) ? "\nCodex 对话 ID：" + target.agentId : "")
                                + "\n\n保存后下一次口令生效。")
                            .setNegativeButton("返回修改", null).setPositiveButton("确认保存", (confirm, which) -> {
                                try {
                                    ensureCurrent.run();
                                    String reason = resolver.blocked(); if (!reason.isEmpty()) throw new IllegalStateException(reason);
                                    settings.save(candidate, vocabulary.current()); saved.run(); dialog.dismiss();
                                    Toast.makeText(activity, "已保存，下一次口令生效", Toast.LENGTH_LONG).show();
                                } catch (RuntimeException error) { Toast.makeText(activity, error.getMessage(), Toast.LENGTH_LONG).show(); }
                            }).show();
                    }
                    public void failed(String message) {
                        if (!dialog.isShowing()) return;
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); enabled(box, true); status.setText(message); status.setVisibility(View.VISIBLE);
                    }
                });
            } catch (RuntimeException failure) {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); enabled(box, true); status.setText(failure.getMessage()); status.setVisibility(View.VISIBLE);
            }
        }));
        dialog.show();
        if (existing != null) dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view ->
            new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle("删除这条快捷方式？")
                .setMessage("只删除手机上的短语绑定。").setNegativeButton("取消", null)
                .setPositiveButton("删除", (confirm, which) -> {
                    try { settings.remove(existing.id, vocabulary.current()); saved.run(); dialog.dismiss(); }
                    catch (RuntimeException failure) { Toast.makeText(activity, failure.getMessage(), Toast.LENGTH_LONG).show(); }
                }).show());
    }
}
