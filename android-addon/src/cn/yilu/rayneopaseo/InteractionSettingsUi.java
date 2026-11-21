package cn.yilu.rayneopaseo;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Edits only phone vocabulary; never touches connection settings or active drafts. */
final class InteractionSettingsUi {
    private InteractionSettingsUi() {}
    static void showPrompts(Activity activity, InteractionSettings settings, Runnable saved) {
        AssistantSettingsUi.choices(activity, "镜片提示",
            () -> new String[]{"进度状态\n回复中、调用工具、完成等状态", "操作与异常提示\n确认、取消和连接异常的显示文字", "恢复镜片提示默认值"}, (dialog, which) -> {
                if (which == 2) new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity))
                    .setTitle("恢复镜片提示默认值？")
                    .setMessage("只恢复显示文案，保留语音口令、快捷方式和连接设置。")
                    .setNegativeButton("取消", null).setPositiveButton("恢复默认", (confirm, ignored) -> {
                        try {
                            Map<String, String> defaults = new HashMap<>();
                            for (InteractionPreferences.Text entry : InteractionPreferences.texts()) defaults.put("text." + entry.id, entry.initial);
                            settings.save(defaults); saved.run(); Toast.makeText(activity, "已恢复，下一轮生效", Toast.LENGTH_LONG).show();
                        }
                        catch (RuntimeException error) { Toast.makeText(activity, error.getMessage(), Toast.LENGTH_LONG).show(); }
                    }).show();
                else showTexts(activity, settings, saved, which == 0);
            });
    }
    static void showCommands(Activity activity, InteractionSettings settings, Runnable saved, String backend) {
        List<InteractionPreferences.Command> entries = ConnectionProfiles.commandsFor(backend);
        AssistantSettingsUi.choices(activity, "语音口令", () -> {
            String[] labels = new String[entries.size() + 1];
            for (int i = 0; i < entries.size(); i++) {
                InteractionPreferences.Command entry = entries.get(i);
                String extra = settings.current().values().get("alias." + entry.id);
                labels[i] = entry.title + "\n" + (extra.isEmpty() ? "内置：" + join(entry.builtins) : "自定义：" + extra.replace('\n', '、'));
            }
            labels[entries.size()] = "恢复全部语音口令默认值\n镜片提示和其他设置保留";
            return labels;
        }, (dialog, index) -> {
                if (index == entries.size()) {
                    new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity)).setTitle("恢复语音口令默认值？")
                        .setMessage("会清除自定义说法，内置口令仍可使用。镜片提示、快捷方式和连接设置保留。")
                        .setNegativeButton("取消", null).setPositiveButton("恢复默认", (confirm, ignored) -> {
                            try {
                                Map<String, String> defaults = new HashMap<>();
                                for (InteractionPreferences.Command entry : InteractionPreferences.commands()) defaults.put("alias." + entry.id, "");
                                settings.save(defaults); saved.run();
                            } catch (RuntimeException error) { Toast.makeText(activity, error.getMessage(), Toast.LENGTH_LONG).show(); }
                        }).show(); return;
                }
                InteractionPreferences.Command command = entries.get(index);
                String hint = "内置说法：" + join(command.builtins) + "\n\n内置说法始终保留。自定义别名每行一个，最多 8 个，留空则只用内置说法。";
                if (command.numbered) hint += "\n用 {数字} 代表编号，例如切到{数字}。";
                if (command.prefix) hint += command.id.equals("create") ? "\n口令后继续说名称，单独说确认发送才创建。"
                    : "\n口令后继续说主题，单独说确认发送才搜索。";
                edit(activity, settings, saved, command.title, "alias." + command.id, "", hint, true, command);
            });
    }
    private static void showTexts(Activity activity, InteractionSettings settings, Runnable saved, boolean progress) {
        List<InteractionPreferences.Text> entries = new ArrayList<>();
        for (InteractionPreferences.Text entry : InteractionPreferences.texts()) if (entry.progress == progress) entries.add(entry);
        AssistantSettingsUi.choices(activity, progress ? "进度状态" : "操作与异常提示", () -> {
            String[] labels = new String[entries.size()];
            for (int i = 0; i < labels.length; i++) labels[i] = entries.get(i).title + "\n" + settings.current().values().get("text." + entries.get(i).id);
            return labels;
        }, (dialog, index) -> {
                InteractionPreferences.Text entry = entries.get(index);
                edit(activity, settings, saved, entry.title, "text." + entry.id, entry.initial,
                    "只改变显示文字，出现时机保持原样。保存后从下一轮生效。\n"
                    + (entry.progress ? "单行显示，最多一屏宽。" : "保留必要的状态说明，最多 200 个字符。")
                    + "留空恢复此项默认值。", false, null);
            });
    }
    private static void edit(Activity activity, InteractionSettings settings, Runnable saved, String title,
                             String key, String initial, String hint, boolean aliases, InteractionPreferences.Command command) {
        AlertDialog.Builder builder = new AlertDialog.Builder(AssistantSettingsUi.dialogContext(activity));
        LinearLayout content = new LinearLayout(builder.getContext());
        content.setOrientation(LinearLayout.VERTICAL); content.setPadding(AssistantSettingsUi.dp(builder.getContext(), 24), AssistantSettingsUi.dp(builder.getContext(), 12), AssistantSettingsUi.dp(builder.getContext(), 24), AssistantSettingsUi.dp(builder.getContext(), 12));
        TextView description = new TextView(builder.getContext()); description.setText(hint); content.addView(description);
        EditText input = new EditText(builder.getContext());
        input.setInputType(InputType.TYPE_CLASS_TEXT | (aliases ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        input.setMinLines(aliases ? 3 : 1); if (!aliases) input.setSingleLine(true);
        input.setText(settings.current().values().get(key)); content.addView(input);
        TextView preview = new TextView(builder.getContext()); preview.setPadding(0, 16, 0, 8); content.addView(preview);
        Runnable updatePreview = () -> {
            try {
                Map<String, String> changes = new HashMap<>(); changes.put(key, input.getText().toString());
                InteractionPreferences next = settings.current().withChanges(changes);
                if (!aliases) preview.setText("镜片预览：\n" + next.values().get(key));
                else {
                    String value = input.getText().toString().trim();
                    String first = value.isEmpty() ? command.builtins.get(0) : value.split("[\\r\\n,，;；]+", -1)[0].trim();
                    String spoken = first.replace(InteractionPreferences.NUMBER, "2");
                    if (command.prefix) spoken += command.id.equals("create") ? "推送调试" : "身份认证";
                    preview.setText("说法预览：" + spoken + "\n执行：" + command.title);
                }
            } catch (IllegalArgumentException error) { preview.setText(error.getMessage()); }
        };
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            public void onTextChanged(CharSequence text, int start, int before, int count) { updatePreview.run(); }
            public void afterTextChanged(Editable text) {}
        });
        updatePreview.run();
        ScrollView scroll = new ScrollView(builder.getContext()); scroll.addView(content);
        AlertDialog dialog = builder.setTitle(title).setView(scroll).setNegativeButton("取消", null)
            .setNeutralButton("填入默认值", null).setPositiveButton("保存", null).create();
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> input.setText(initial));
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    Map<String, String> changes = new HashMap<>(); changes.put(key, input.getText().toString());
                    settings.save(changes); saved.run();
                    Toast.makeText(activity, "已保存，下一轮生效", Toast.LENGTH_LONG).show(); dialog.dismiss();
                } catch (RuntimeException error) { input.setError(error.getMessage()); }
            });
        });
        dialog.show();
    }
    private static String join(List<String> values) {
        StringBuilder text = new StringBuilder();
        for (String value : values) { if (text.length() > 0) text.append("、"); text.append(value); }
        return text.toString();
    }
}
