package cn.yilu.rayneopaseo;

import java.util.ArrayList;
import java.util.List;

/** In-memory reading of the latest delivered answer; null means existing dispatch. */
final class AnswerBrowser {
    private static final int LINE_WIDTH = 48; // 24 Chinese glyphs in half-width units.
    private static final int SCREEN_LINES = 4;
    private final List<String> pages = new ArrayList<>();
    private boolean browsing;
    private int page;

    String route(String question) {
        String command = VoiceCommand.normalize(question);
        int target = VoiceCommand.readingPage(command);
        if (target >= 0) {
            if (pages.isEmpty()) return "当前没有可浏览的回答，请先提问。";
            if (target == 0 || target > pages.size()) return "共 " + pages.size()
                + " 段，请说第1段到第" + pages.size() + "段。当前位置未变。";
            browsing = true; page = target - 1;
            return render();
        }
        if ("从头浏览".equals(command)) {
            if (pages.isEmpty()) return "当前没有可浏览的回答，请先提问。";
            browsing = true; page = 0;
            return render();
        }
        boolean next = "下一页".equals(command) || "下一段".equals(command) || "继续浏览".equals(command);
        boolean previous = "上一页".equals(command) || "上一段".equals(command);
        if (next || previous) {
            if (browsing) {
                page = Math.max(0, Math.min(pages.size() - 1, page + (next ? 1 : -1)));
                return render();
            }
            if (!"下一页".equals(command) && !"上一页".equals(command)) return "请先说从头浏览。";
        }
        // A new question or navigation can change the selected Agent. Never replay
        // text from the previous context after such a transition, even on failure.
        clear();
        return null;
    }

    void completed(String question, String text, String outcome) {
        if (!"idle".equals(outcome) || VoiceCommand.isControl(question) || text == null || text.trim().isEmpty()) return;
        clear();
        String displayText = text.replace("\r\n", "\n").replace('\r', '\n');
        // Total-count digits themselves take first-line space. Reflow only
        // when that width changes; afterward every cursor uses frozen pages.
        int totalHint = 1;
        while (true) {
            pages.clear();
            int start = 0;
            while (start < displayText.length()) start = appendScreen(displayText, start, totalHint);
            if (Integer.toString(pages.size()).length() == Integer.toString(totalHint).length()) break;
            totalHint = pages.size();
        }
    }

    private int appendScreen(String text, int start, int totalHint) {
        int column = label(pages.size() + 1, totalHint).length(), line = 1, at = start;
        StringBuilder body = new StringBuilder();
        while (at < text.length()) {
            int cp = text.codePointAt(at);
            if (cp == '\n') {
                at++;
                // This source newline becomes the page boundary itself, rather
                // than a fifth empty row or an empty first row on the next page.
                if (line == SCREEN_LINES) break;
                body.append('\n'); line++; column = 0;
                continue;
            }
            int width = width(cp);
            if (column + width > LINE_WIDTH) {
                if (line == SCREEN_LINES) break;
                body.append('\n'); line++; column = 0;
            }
            if (cp == '\t') body.append("    ");
            else body.appendCodePoint(cp);
            column += width;
            at += Character.charCount(cp);
        }
        pages.add(body.toString());
        return at;
    }

    private static int width(int cp) {
        if (cp == '\t') return 4;
        int type = Character.getType(cp);
        if (type == Character.NON_SPACING_MARK || type == Character.ENCLOSING_MARK || cp == 0x200D) return 0;
        return cp >= 0x20 && cp <= 0x7E ? 1 : 2;
    }

    private static String label(int page, int total) { return page + "/" + total + " "; }
    private String render() { return label(page + 1, pages.size()) + pages.get(page); }
    void stopBrowsing() { browsing = false; page = 0; }
    void clear() { stopBrowsing(); pages.clear(); }
}
