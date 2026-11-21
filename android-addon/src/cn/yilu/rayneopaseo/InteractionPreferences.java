package cn.yilu.rayneopaseo;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Immutable phone-only vocabulary. User aliases always resolve to existing actions. */
final class InteractionPreferences {
    static final String NUMBER = "{数字}";
    static final class Command {
        final String id, title, canonical;
        final List<String> builtins;
        final boolean prefix, numbered;
        Command(String id, String title, String canonical, boolean prefix, boolean numbered, String... builtins) {
            this.id = id; this.title = title; this.canonical = canonical; this.prefix = prefix; this.numbered = numbered;
            this.builtins = Collections.unmodifiableList(Arrays.asList(builtins));
        }
    }
    static final class Text {
        final String id, title, initial;
        final boolean progress;
        final List<String> originals;
        Text(String id, String title, String initial, boolean progress, String... originals) {
            this.id = id; this.title = title; this.initial = initial; this.progress = progress;
            List<String> all = new ArrayList<>(); all.add(initial); all.addAll(Arrays.asList(originals));
            this.originals = Collections.unmodifiableList(all);
        }
    }
    private static final List<Command> COMMANDS = Collections.unmodifiableList(Arrays.asList(
        new Command("confirm", "确认发送", "确认发送", false, false, "确认发送"),
        new Command("cancel", "取消发送", "取消发送", false, false, "取消发送"),
        new Command("exit", "结束对话", "结束对话", false, false, "结束对话", "退出对话"),
        new Command("search", "查找对话，后接主题", "查找对话", true, false, "查找对话", "查询对话"),
        new Command("create", "新建对话，后接名称", "新建对话", true, false, "新建对话"),
        new Command("current", "当前 Agent", "当前Agent", false, false, "当前Agent", "当前会话", "进入Paseo", "进入对话"),
        new Command("workspace", "当前项目", "当前项目", false, false, "当前项目"),
        new Command("mode", "当前模式", "当前模式", false, false, "当前模式"),
        new Command("help", "口令帮助", "口令帮助", false, false, "口令帮助"),
        new Command("workspaces", "列出项目", "列出项目", false, false, "列出项目", "项目列表"),
        new Command("agents", "列出 Agent", "列出Agent", false, false, "列出Agent", "Agent列表"),
        new Command("recent", "最近对话", "最近对话", false, false, "最近对话", "列出最近对话"),
        new Command("browse_first", "从头浏览", "从头浏览", false, false, "从头浏览"),
        new Command("browse_continue", "继续浏览", "继续浏览", false, false, "继续浏览"),
        new Command("next", "下一页或下一段", "下一页", false, false, "下一页", "下一段"),
        new Command("previous", "上一页或上一段", "上一页", false, false, "上一页", "上一段"),
        new Command("select", "选择编号，用 {数字} 占位", "选择", false, true,
            "选择{数字}", "选择第{数字}", "选择第{数字}个", "选择第{数字}项", "选择第{数字}号", "选择{数字}个", "选择{数字}项", "选择{数字}号"),
        new Command("jump", "跳转段号，用 {数字} 占位", "第", false, true,
            "第{数字}段", "第{数字}页", "跳到第{数字}段", "跳到第{数字}页", "跳转到第{数字}段", "跳转到第{数字}页")
    ));
    private static final List<Text> TEXTS = Collections.unmodifiableList(Arrays.asList(
        new Text("searching", "正在查找", "（正在查找）", true),
        new Text("creating", "正在创建", "（正在创建）", true),
        new Text("working", "回复中", "（回复中）", true),
        new Text("tool", "调用工具", "（调用工具）", true),
        new Text("approval", "等待授权进度", "（等待授权，请在原客户端处理）", true),
        new Text("complete", "本轮完成", "（本轮完成）", true),
        new Text("cancelled", "已取消发送", "已取消发送。", false),
        new Text("exited", "已结束对话", "已结束对话。", false),
        new Text("permission", "等待授权", "等待授权，请在原客户端处理。", false,
            "Paseo 正等待授权，请在手机或电脑上处理。", "Agent 正等待你在 Paseo 中授权。"),
        new Text("busy", "Agent 忙碌", "Agent 正在执行，请等待完成并查看原会话。", false,
            "Agent 正在执行，请等待完成并查看原会话。", "Agent 当前不能接收测试消息。", "已有任务执行中，请等完成后再选择或发送。", "已有请求执行中，请等待并查看原会话。"),
        new Text("offline", "电脑连接恢复", "电脑正在恢复连接，本次未提交；请稍后核对原客户端再发送。", false,
            "电脑正在恢复 Paseo 连接，本次未提交；请稍后核对原会话再发送。"),
        new Text("unauthorized", "令牌校验失败", "访问令牌未通过，请在手机设置中检查；本次未提交。", false),
        new Text("storage", "电脑记录保存失败", "电脑未能保存选择或请求记录，本次未提交；请检查电脑存储。", false,
            "电脑未能保存选择或请求记录，本次未提交；请检查电脑存储。", "未能保存选择或请求记录，本次没有重新发送；请检查电脑存储。"),
        new Text("target", "项目或 Agent 变化", "项目或 Agent 已变化，请重新列出并选择。", false,
            "项目或 Agent 已变化，请重新列出并选择。", "Agent 或工作区已变化。", "指定 Agent 不存在。", "当前项目已不可用，请重新选择项目，可说列出项目。"),
        new Text("endpoint", "接入地址不匹配", "接入地址不匹配，请检查手机中的 HTTPS 地址；不要重复发送。", false),
        new Text("navigation", "会话或名单变化", "导航会话已变化，本次未发送。请重新列出名单。", false,
            "导航会话已变化，本次未发送。请重新列出名单。", "导航会话已变化，本次未发送。请重新列出名单。", "名单已失效，请重新列出后选择。"),
        new Text("search_unsupported", "电脑入口不支持搜索", "当前电脑入口不支持查找对话，本次未发送。请更新电脑接入服务。", false),
        new Text("search_mode", "当前连接模式不支持搜索", "当前电脑入口不支持查找对话，请检查连接或更新电脑接入服务。", false,
            "查找对话目前支持 Paseo 模式，请先切换连接模式。"),
        new Text("timeout", "等待超时", "等待超时，任务可能仍在执行；请查看原客户端，不要重复发送。", false,
            "等待超时，请查看 Paseo 原会话，不要重复发送。", "Paseo 任务仍可能在执行，请查看原会话，不要重复发送。"),
        new Text("unknown", "发送或回复状态未确认", "发送或回复状态未确认，请查看原客户端，不要重复发送。", false,
            "无法确认 Paseo 回复，请检查网络、电脑接入及原会话；不要重复发送。", "发送结果暂时无法确认，请查看原会话，不要重复发送。", "暂时无法连接 Paseo，请查看原会话确认状态。"),
        new Text("error", "本轮执行失败", "本轮执行失败，请查看原客户端。", false,
            "Paseo 本轮执行失败，请查看原会话。"),
        new Text("listing_error", "名单读取失败", "未能读取或核对名单，没有发送消息。请重新列出后再选择。", false),
        new Text("browse_empty", "没有可浏览回答", "当前没有可浏览的回答，请先提问。", false),
        new Text("browse_start", "尚未进入浏览", "请先说从头浏览。", false),
        new Text("invalid_command", "指令参数不正确", "指令参数不正确，请补充编号，或说口令帮助。", false),
        new Text("creation_success", "新建成功", "新对话已创建并选中。", false),
        new Text("creation_unsupported", "电脑入口不支持新建", "当前电脑入口不支持语音新建，本次未创建。请更新电脑接入服务。", false),
        new Text("creation_mode", "当前模式不支持新建", "当前电脑入口不支持语音新建，请检查连接或更新电脑接入服务。", false,
            "语音新建目前只支持Paseo模式，请先切换连接模式。"),
        new Text("creation_profile", "新建配置不可用", "找不到唯一可用的日常工作配置，本次未创建。请在 Paseo 检查配置。", false),
        new Text("creation_name", "新建名称不正确", "请在新建对话后补充名称，最多 40 个字符。", false),
        new Text("creation_scope", "新建项目不可用", "请先选择可用项目，再说新建对话和名称。", false),
        new Text("creation_duplicate", "新建名称重复", "当前项目已有同名对话，本次未创建。请换个名称，或列出 Agent 选择已有对话。", false),
        new Text("creation_replay", "新建请求已处理", "此创建请求已处理，没有重复创建。请列出 Agent 核对后选择。", false),
        new Text("creation_uncertain", "新建结果未确认", "创建结果暂时未确认，请在 Paseo 核对，不要重复新建。", false),
        new Text("creation_storage", "创建记录保存失败", "创建记录未能保存，本次未继续创建或切换。请在 Paseo 核对。", false),
        new Text("creation_selection", "新建成功但未切换", "新对话已创建，但未能切换。请列出 Agent 核对后选择，不要重复新建。", false),
        new Text("creation_changed", "新建期间会话变化", "会话已变化或创建结果未确认，请在 Paseo 核对；本次未切换，不要重复新建。", false)
    ));
    static List<Command> commands() { return COMMANDS; }
    static List<Text> texts() { return TEXTS; }
    static final class Resolution {
        final String action, text, hint;
        Resolution(String action, String text, String hint) { this.action = action; this.text = text; this.hint = hint; }
    }
    private static final class Alias {
        final Command command;
        final String word, prefix, suffix;
        final boolean builtin;
        final int sourceLength;
        Alias(Command command, String value, boolean builtin) {
            this.command = command; this.word = normalize(value); this.builtin = builtin;
            this.sourceLength = VoiceCommand.normalize(value).length();
            int at = word.indexOf(NUMBER);
            prefix = at < 0 ? word : word.substring(0, at);
            suffix = at < 0 ? "" : word.substring(at + NUMBER.length());
        }
    }
    private final Map<String, String> values;
    private final List<Alias> aliases;
    private InteractionPreferences(Map<String, String> values, List<Alias> aliases) {
        this.values = Collections.unmodifiableMap(new LinkedHashMap<>(values));
        this.aliases = Collections.unmodifiableList(new ArrayList<>(aliases));
    }
    static InteractionPreferences defaults() { return fromStored(Collections.<String, Object>emptyMap()); }
    private static String legacyDefault(String id) {
        switch (id) {
            case "permission": return "Paseo 正等待授权，请在手机或电脑上处理。";
            case "offline": return "电脑正在恢复 Paseo 连接，本次未提交；请稍后核对原会话再发送。";
            case "timeout": return "等待超时，请查看 Paseo 原会话，不要重复发送。";
            case "unknown": return "无法确认 Paseo 回复，请检查网络、电脑接入及原会话；不要重复发送。";
            case "error": return "Paseo 本轮执行失败，请查看原会话。";
            case "search_mode": return "查找对话目前支持 Paseo 模式，请先切换连接模式。";
            case "creation_mode": return "语音新建目前只支持Paseo模式，请先切换连接模式。";
            default: return null;
        }
    }
    static InteractionPreferences fromStored(Map<String, ?> source) {
        Map<String, String> values = new LinkedHashMap<>();
        List<Alias> aliases = new ArrayList<>();
        for (Command command : COMMANDS) {
            String key = "alias." + command.id, extra = read(source, key, "").trim();
            values.put(key, extra);
            for (String word : command.builtins) aliases.add(new Alias(command, word, true));
            if (extra.isEmpty()) continue;
            String[] words = extra.split("[\\r\\n,，;；]+", -1);
            if (words.length > 8) throw new IllegalArgumentException(command.title + "：最多添加 8 个别名");
            for (String word : words) {
                word = word.trim(); String normalized = normalize(word);
                if (commandKey(normalized.replace(NUMBER, "")).length() < 2 || normalized.length() > 32 || word.matches("(?s).*[\\p{Cntrl}].*"))
                    throw new IllegalArgumentException(command.title + "：别名需为 2 至 32 个字符");
                if (Arrays.asList("小雷小雷", "heyrayneo", "okrayneo").contains(commandKey(normalized)))
                    throw new IllegalArgumentException("系统唤醒词不能用作业务口令");
                int count = normalized.split(Pattern.quote(NUMBER), -1).length - 1;
                if ((command.numbered && (count != 1 || normalized.replace(NUMBER, "").length() < 2))
                    || (!command.numbered && count != 0) || normalized.replace(NUMBER, "").matches(".*[{}].*"))
                    throw new IllegalArgumentException(command.title + "：请正确填写一次 {数字} 占位符");
                aliases.add(new Alias(command, word, false));
            }
        }
        for (int i = 0; i < aliases.size(); i++) for (int j = i + 1; j < aliases.size(); j++) {
            Alias a = aliases.get(i), b = aliases.get(j);
            if (a.command.id.equals(b.command.id)) continue;
            String aWord = commandKey(a.word), bWord = commandKey(b.word);
            String aPrefix = commandKey(a.prefix), bPrefix = commandKey(b.prefix);
            if (aWord.equals(bWord) || ((a.command.prefix || a.command.numbered) && bPrefix.startsWith(aPrefix))
                || ((b.command.prefix || b.command.numbered) && aPrefix.startsWith(bPrefix)))
                throw new IllegalArgumentException("口令冲突：" + a.command.title + " 与 " + b.command.title);
        }
        for (Text text : TEXTS) {
            String value = read(source, "text." + text.id, text.initial).trim();
            // Upgrade only exact old built-in defaults; custom wording and aliases remain untouched.
            if (value.equals(legacyDefault(text.id))) value = text.initial;
            if (value.isEmpty()) value = text.initial;
            if (value.matches("(?s).*[\\p{Cntrl}].*") || value.length() > (text.progress ? 24 : 200)
                || (text.progress && width(value) > 48))
                throw new IllegalArgumentException(text.title + "：请使用单行短文案" + (text.progress ? "，最多一屏宽" : ""));
            values.put("text." + text.id, value);
        }
        aliases.sort((a, b) -> Integer.compare(b.prefix.length(), a.prefix.length()));
        return new InteractionPreferences(values, aliases);
    }
    private static String read(Map<String, ?> source, String key, String fallback) {
        Object value = source.get(key);
        if (value == null) return fallback;
        if (!(value instanceof String)) throw new IllegalArgumentException("设置格式无效：" + key);
        return (String)value;
    }
    InteractionPreferences withChanges(Map<String, String> changes) {
        Map<String, String> next = new LinkedHashMap<>(values);
        for (Map.Entry<String, String> entry : changes.entrySet()) {
            if (!next.containsKey(entry.getKey()) || entry.getValue() == null) throw new IllegalArgumentException("未知设置项");
            next.put(entry.getKey(), entry.getValue());
        }
        return fromStored(next);
    }
    Map<String, String> values() { return new LinkedHashMap<>(values); }
    String text(String id) { String value = values.get("text." + id); return value == null ? "" : value; }
    String localize(String original) {
        String created = "新对话已创建并选中。";
        if (original.startsWith(created + "\n")) return text("creation_success") + original.substring(created.length());
        for (Text text : TEXTS) if (text.originals.contains(original)) return text(text.id);
        return original;
    }
    Resolution resolve(String input) {
        String normalized = normalize(input); Alias invalid = null;
        for (Alias alias : aliases) {
            Command command = alias.command;
            if (command.numbered) {
                if (!normalized.startsWith(alias.prefix)) continue;
                if (!alias.builtin) invalid = alias;
                if (!normalized.endsWith(alias.suffix) || normalized.length() < alias.prefix.length() + alias.suffix.length()) continue;
                String number = normalized.substring(alias.prefix.length(), normalized.length() - alias.suffix.length());
                if (!number.matches("[0-9零〇一二两三四五六七八九十百千]+")) continue;
                int value = VoiceCommand.readingPage("第" + number + "段");
                String canonical = command.id.equals("select") ? "选择" + value : "第" + value + "段";
                if (alias.builtin && VoiceCommand.isControl(input)) canonical = input;
                return new Resolution(command.id, canonical, "");
            }
            if (command.prefix ? !normalized.startsWith(alias.word) : !normalized.equals(alias.word)) continue;
            String canonical = command.prefix ? command.canonical + VoiceCommand.normalize(input).substring(alias.sourceLength) : command.canonical;
            if (command.id.equals("create")) canonical = command.canonical + VoiceCommand.afterPrefix(input, alias.sourceLength);
            if (alias.builtin && !Arrays.asList("confirm", "cancel", "exit").contains(command.id)) canonical = input;
            return new Resolution(command.id, canonical, "");
        }
        return invalid == null ? new Resolution("", input, "") : new Resolution(invalid.command.id, "", text("invalid_command"));
    }
    boolean reservedShortcut(String input) {
        String word = commandKey(normalize(input));
        if (Arrays.asList("小雷", "小雷小雷", "heyrayneo", "okrayneo").contains(word)) return true;
        for (Alias alias : aliases) {
            String exact = commandKey(alias.word), prefix = commandKey(alias.prefix);
            if (word.equals(exact) || ((alias.command.prefix || alias.command.numbered) && word.startsWith(prefix))) return true;
        }
        return VoiceCommand.isControl(input) || VoiceCommand.isSearch(input) || VoiceCommand.isCreate(input);
    }
    private static String normalize(String text) { return VoiceCommand.normalize(text).toLowerCase(Locale.ROOT); }
    // Draft confirmation ignores punctuation; validation must reserve those spellings too.
    // Include ASCII colon because NFKC normalization converts the Chinese colon to it.
    private static String commandKey(String value) { return value.replaceAll("[\\s，。！？；：、,.:;!?]+", ""); }
    private static int width(String value) { int width = 0; for (int i = 0; i < value.length();) {
        int cp = value.codePointAt(i); width += cp >= 32 && cp <= 126 ? 1 : 2; i += Character.charCount(cp);
    } return width; }
}
