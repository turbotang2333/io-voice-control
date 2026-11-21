package cn.yilu.rayneopaseo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Immutable local bindings. A workspace entry contains no seed Agent identity. */
final class ShortcutBindings {
    static final class Entry {
        final String id, phrases, kind, serverId, workspaceId, agentId, workspaceName, agentName;
        Entry(String id, String phrases, String kind, String serverId, String workspaceId, String agentId, String workspaceName, String agentName) {
            this.id = id; this.phrases = phrases == null ? "" : phrases.trim(); this.kind = kind;
            this.serverId = serverId; this.workspaceId = workspaceId; this.agentId = agentId == null ? "" : agentId;
            this.workspaceName = workspaceName == null ? "" : workspaceName; this.agentName = agentName == null ? "" : agentName;
        }
        Entry withPhrases(String next) { return new Entry(id, next, kind, serverId, workspaceId, agentId, workspaceName, agentName); }
        String targetName() { return "workspace".equals(kind) ? workspaceName : agentName; }
    }
    private final List<Entry> entries;
    private ShortcutBindings(List<Entry> entries) { this.entries = Collections.unmodifiableList(new ArrayList<>(entries)); }
    static ShortcutBindings empty() { return new ShortcutBindings(Collections.<Entry>emptyList()); }
    List<Entry> entries() { return entries; }
    static String key(String text) { return VoiceCommand.normalize(text).toLowerCase(Locale.ROOT); }
    static List<String> phrases(String input, InteractionPreferences vocabulary) {
        if (input == null || input.length() > 512) throw new IllegalArgumentException("每条最多 8 个短语，每个 2 至 32 个字符");
        if (vocabulary.reservedShortcut(input)) throw new IllegalArgumentException("快捷短语与已有口令或系统唤醒词冲突");
        String[] values = input.split("[\\r\\n,，;；]+", -1);
        if (values.length == 0 || values.length > 8) throw new IllegalArgumentException("每条最多填写 8 个短语");
        List<String> result = new ArrayList<>(); Set<String> seen = new HashSet<>();
        for (String value : values) {
            value = value.trim(); String normalized = key(value);
            if (normalized.length() < 2 || normalized.length() > 32 || value.matches("(?s).*[\\p{Cntrl}{}].*"))
                throw new IllegalArgumentException("快捷短语需为 2 至 32 个字符");
            if (vocabulary.reservedShortcut(value)) throw new IllegalArgumentException("快捷短语与已有口令或系统唤醒词冲突");
            if (!seen.add(normalized)) throw new IllegalArgumentException("快捷短语重复");
            result.add(value);
        }
        return result;
    }
    private static boolean id(String value) { return value != null && value.matches("[A-Za-z0-9_-]{1,128}"); }
    private static boolean workspaceId(String value) {
        return value != null && value.length() <= 4096 && !value.trim().isEmpty() && !value.matches("(?s).*[\\p{Cc}].*");
    }
    private static void validate(Entry entry, InteractionPreferences vocabulary) {
        if (entry == null || !id(entry.id) || !id(entry.serverId) || !workspaceId(entry.workspaceId)
            || !("agent".equals(entry.kind) ? id(entry.agentId) : "workspace".equals(entry.kind) && entry.agentId.isEmpty()))
            throw new IllegalArgumentException("快捷目标格式无效，请重新核对 Agent ID");
        if (entry.workspaceName.isEmpty() || entry.workspaceName.length() > 100 || entry.agentName.length() > 100
            || ("agent".equals(entry.kind) && entry.agentName.isEmpty())
            || (entry.workspaceName + entry.agentName).matches("(?s).*[\\p{Cntrl}].*"))
            throw new IllegalArgumentException("快捷目标名称无效，请重新核对");
        phrases(entry.phrases, vocabulary);
    }
    ShortcutBindings with(Entry entry, InteractionPreferences vocabulary) {
        List<Entry> next = new ArrayList<>();
        for (Entry previous : entries) if (!previous.id.equals(entry.id)) next.add(previous);
        next.add(entry); return checked(next, vocabulary);
    }
    ShortcutBindings without(String id, InteractionPreferences vocabulary) {
        List<Entry> next = new ArrayList<>(); for (Entry entry : entries) if (!entry.id.equals(id)) next.add(entry);
        return checked(next, vocabulary);
    }
    private static ShortcutBindings checked(List<Entry> entries, InteractionPreferences vocabulary) {
        if (entries.size() > 24) throw new IllegalArgumentException("首版最多保存 24 条快捷方式");
        Set<String> ids = new HashSet<>(), words = new HashSet<>();
        for (Entry entry : entries) {
            validate(entry, vocabulary);
            if (!ids.add(entry.id)) throw new IllegalArgumentException("快捷方式编号重复");
            for (String phrase : phrases(entry.phrases, vocabulary)) if (!words.add(key(phrase)))
                throw new IllegalArgumentException("快捷短语已被其他快捷方式使用");
        }
        return new ShortcutBindings(entries);
    }
    Entry match(String text) {
        String normalized = key(text);
        for (Entry entry : entries) for (String phrase : entry.phrases.split("[\\r\\n,，;；]+", -1))
            if (key(phrase).equals(normalized)) return entry;
        return null;
    }
    Map<String, String> values() {
        Map<String, String> values = new LinkedHashMap<>(); values.put("shortcuts.version", "1");
        StringBuilder ids = new StringBuilder();
        for (Entry entry : entries) {
            if (ids.length() > 0) ids.append(','); ids.append(entry.id);
            String prefix = "shortcut." + entry.id + ".";
            values.put(prefix + "phrases", entry.phrases); values.put(prefix + "kind", entry.kind);
            values.put(prefix + "serverId", entry.serverId); values.put(prefix + "workspaceId", entry.workspaceId);
            values.put(prefix + "agentId", entry.agentId); values.put(prefix + "workspaceName", entry.workspaceName); values.put(prefix + "agentName", entry.agentName);
        }
        values.put("shortcuts.ids", ids.toString()); return values;
    }
    private static String read(Map<String, ?> source, String key) {
        Object value = source.get(key); if (!(value instanceof String)) throw new IllegalArgumentException("快捷方式配置无法读取，请在手机重置快捷方式");
        return (String)value;
    }
    static ShortcutBindings fromStored(Map<String, ?> source, InteractionPreferences vocabulary) {
        if (source.isEmpty()) return empty();
        if (!"1".equals(read(source, "shortcuts.version"))) throw new IllegalArgumentException("快捷方式配置版本无效");
        String ids = read(source, "shortcuts.ids"); List<Entry> entries = new ArrayList<>();
        if (ids.length() > 3200) throw new IllegalArgumentException("快捷方式配置过大");
        if (!ids.isEmpty()) for (String id : ids.split(",", -1)) {
            String prefix = "shortcut." + id + ".";
            entries.add(new Entry(id, read(source, prefix + "phrases"), read(source, prefix + "kind"), read(source, prefix + "serverId"),
                read(source, prefix + "workspaceId"), read(source, prefix + "agentId"), read(source, prefix + "workspaceName"), read(source, prefix + "agentName")));
        }
        return checked(entries, vocabulary);
    }
}
