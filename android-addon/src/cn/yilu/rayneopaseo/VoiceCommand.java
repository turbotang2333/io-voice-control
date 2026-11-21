package cn.yilu.rayneopaseo;

import java.util.regex.Pattern;
import java.util.regex.Matcher;
import java.text.Normalizer;

/** Exact navigation utterances; ordinary questions keep the explicit send gate. */
final class VoiceCommand {
    private static final Pattern READING_PAGE = Pattern.compile(
        "(?:跳到|跳转到)?第([0-9]+|[零〇一二两三四五六七八九十百千]+)(?:段|页)");
    private static final Pattern CONTROL = Pattern.compile(
        "(?:进入(?:Paseo|对话)|当前(?:Agent|项目|会话|模式)|口令帮助|列出项目|项目列表"
        + "|列出Agent|Agent列表|(?:列出)?最近对话|下一页|上一页"
        + "|从头浏览|继续浏览|下一段|上一段"
        + "|选择第?(?:[0-9]+|[零〇一二两三四五六七八九十百]+)(?:个|项|号)?)",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    static boolean isControl(String text) {
        if (text == null) return false;
        return CONTROL.matcher(normalize(text)).matches() || readingPage(text) >= 0;
    }
    /** -1 is ordinary input; 0 is a recognized but invalid local jump. */
    static int readingPage(String text) {
        Matcher match = READING_PAGE.matcher(normalize(text));
        if (!match.matches()) return -1;
        String value = match.group(1);
        boolean units = value.matches(".*[十百千].*");
        int total = 0, pending = -1, lastUnit = 10000;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            int digit = ch >= '0' && ch <= '9' ? ch - '0'
                : ch == '〇' ? 0 : ch == '两' ? 2 : "零一二三四五六七八九".indexOf(ch);
            if (!units) {
                if (digit < 0 || total > (Integer.MAX_VALUE - digit) / 10) return 0;
                total = total * 10 + digit;
            } else if (digit >= 0) {
                if (pending > 0) return 0;
                pending = digit;
            } else {
                int unit = ch == '千' ? 1000 : ch == '百' ? 100 : 10;
                if (unit >= lastUnit || pending == 0) return 0;
                total += (pending < 0 ? 1 : pending) * unit;
                pending = -1; lastUnit = unit;
            }
        }
        return units && pending >= 0 ? total + pending : total;
    }
    static String normalize(String text) {
        return text == null ? "" : Normalizer.normalize(text, Normalizer.Form.NFKC).replaceAll("\\s+", "")
            .replaceFirst("[，。！？；,.;!?]+$", "").replaceFirst("^(?:请(?:帮我)?|帮我)", "");
    }
    static boolean isModeQuery(String text) {
        if (text == null) return false;
        return normalize(text).equals("当前模式");
    }
    static boolean isSearch(String text) { return normalize(text).matches("(?:查找|查询)对话.*"); }
    static boolean isBareSearch(String text) { return normalize(text).matches("(?:查找|查询)对话[，。！？；：、,.;!?]*"); }
    static boolean isCreate(String text) { return normalize(text).startsWith("新建对话"); }
    static boolean isBareCreate(String text) { return normalize(text).matches("新建对话[，。！？；：、,.:;!?]*"); }
    static boolean isBarePending(String text) { return isBareSearch(text) || isBareCreate(text); }
    static boolean samePending(String draft, String next) {
        return (isBareSearch(draft) && isSearch(next)) || (isBareCreate(draft) && isCreate(next));
    }
    static boolean creationBlocked(String text, boolean supported) { return isCreate(text) && !supported; }
    /** Keep spaces and case in a new conversation's name while matching a compact spoken prefix. */
    static String afterPrefix(String text, int prefixLength) {
        String value = Normalizer.normalize(text, Normalizer.Form.NFKC).trim();
        String compact = value.replaceAll("\\s+", "");
        int polite = compact.startsWith("请帮我") ? 3 : compact.startsWith("帮我") ? 2 : compact.startsWith("请") ? 1 : 0;
        int at = 0, seen = 0;
        while (at < value.length() && seen < polite + prefixLength) {
            if (!Character.isWhitespace(value.charAt(at))) seen++;
            at++;
        }
        return value.substring(at).replaceFirst("[，。！？；,.;!?]+$", "").trim();
    }
    static boolean searchBlocked(String text, boolean supported) { return isSearch(text) && !supported; }
    static boolean isExit(String text) {
        if (text == null) return false;
        return text.trim().replaceFirst("[，。！？；,.;!?]+$", "").trim()
            .matches("(?:结束|退出)对话");
    }
}
