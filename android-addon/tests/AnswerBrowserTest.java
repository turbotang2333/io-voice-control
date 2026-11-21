package cn.yilu.rayneopaseo;

import java.lang.reflect.*;

/** Tests cache lifetime, exact local routing and lossless bidirectional reading. */
public final class AnswerBrowserTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static String body(String rendered) { return rendered.substring(rendered.indexOf(' ') + 1); }
    private static String content(String rendered) { return body(rendered).replace("\n", ""); }
    private static void fitsScreen(String rendered) {
        String[] lines = rendered.split("\n", -1);
        check(lines.length <= 4, "A page including its label must fit four lines");
        for (String line : lines) {
            int width = 0;
            for (int cp : line.codePoints().toArray()) width += cp < 128 ? 1 : 2;
            check(width <= 48, "Each line must fit 24 Chinese-character widths");
        }
    }
    public static void main(String[] args) throws Exception {
        AnswerBrowser screen = new AnswerBrowser();
        screen.completed("普通问题", "字".repeat(200), "idle");
        String screenFirst = screen.route("从头浏览");
        String expected = "1/3 " + "字".repeat(22) + "\n" + "字".repeat(24)
            + "\n" + "字".repeat(24) + "\n" + "字".repeat(24);
        check(expected.equals(screenFirst), "Pack 94 Chinese characters in four lines with an inline page label");
        check(content(screenFirst).length() == 94, "Label consumes space on the first line only");
        check(screenFirst.equals(screen.route("上一段")), "Previous cannot wrap from the first screen");
        String screenSecond = screen.route("下一页");
        check(content(screenSecond).length() == 94, "Second screen must be filled too");
        check(screenFirst.equals(screen.route("上一页")), "Going back must recover the exact screen");
        check(screenSecond.equals(screen.route("下一段")), "Page and segment aliases share one cursor");
        check(screen.route("下一页").equals("3/3 " + "字".repeat(12)), "Last screen contains the exact remaining text");
        screen.completed("普通问题", "一\n二\n\n三\n四", "idle");
        check("1/2 一\n二\n\n三".equals(screen.route("从头浏览")), "Original paragraph and blank lines consume screen rows");
        check("2/2 四".equals(screen.route("下一页")), "A line break at a page boundary must not add a fifth or empty first row");
        screen.completed("普通问题", "A".repeat(200), "idle");
        check(content(screen.route("从头浏览")).length() == 188, "Half-width Latin characters must use the available space");
        screen.completed("普通问题", "字".repeat(940), "idle");
        String manyFirst = screen.route("从头浏览");
        check(manyFirst.startsWith("1/11 "), "Total page count must account for its own extra digits");
        check(content(manyFirst).length() == 93, "Two-digit total requires a wider first-line label");
        String all = content(manyFirst), current = manyFirst;
        for (int i = 2; i <= 11; i++) {
            fitsScreen(current);
            current = screen.route("下一页"); all += content(current);
        }
        fitsScreen(current);
        check("字".repeat(940).equals(all), "Page-count recalculation cannot skip or repeat text");
        String eleven = current;
        String ten = screen.route("上一段"), nine = screen.route("上一段");
        check(ten.equals(screen.route("第十段")), "Chinese ordinal must jump to the exact frozen page");
        check(nine.equals(screen.route("上一页")), "Previous after jumping starts at the new cursor");
        check(eleven.equals(screen.route("第 １１ 页。")), "Full-width and spaced decimal ordinals must work");
        check(ten.equals(screen.route("跳到第10段")), "Explicit jump alias must use the same pages");
        check(screen.route("第十二段").contains("11"), "Out-of-range jump must report the total locally");
        check(eleven.equals(screen.route("下一段")), "Rejected jump must leave the cursor unchanged");
        for (String invalid : new String[]{"第零段", "第0页", "第十十段", "第999999999999999999段"}) {
            check(screen.route(invalid) != null, "Invalid page numbers must stay local");
            check(ten.equals(screen.route("上一段")), "Invalid number cannot alter or discard the current answer");
            check(eleven.equals(screen.route("下一段")), "Return to last page for the next invalid-number check");
        }
        screen.stopBrowsing();
        check(ten.equals(screen.route("请帮我跳转到第十页。")), "A cached answer can be entered directly at the requested page");
        check(VoiceCommand.readingPage("第一百零二段") == 102, "Hundreds with zero must parse correctly");
        check(VoiceCommand.readingPage("第一千零二十一段") == 1021, "Thousands must parse correctly");
        check(VoiceCommand.readingPage("第两百一十段") == 210, "Spoken two must be accepted");
        check(VoiceCommand.readingPage("第一〇一段") == 101, "Digit-by-digit Chinese numbers must be accepted");
        check(VoiceCommand.readingPage("选择第十项") == -1, "List selection must never become a reading jump");
        String mixed = "中A文123。".repeat(40);
        screen.completed("普通问题", mixed, "idle");
        current = screen.route("从头浏览"); all = content(current);
        while (true) {
            fitsScreen(current);
            String after = screen.route("下一页");
            if (after.equals(current)) break;
            all += content(after); current = after;
        }
        check(mixed.equals(all), "Mixed-width text must remain complete without stopping at full stops");
        Class<?> type;
        try { type = Class.forName("cn.yilu.rayneopaseo.AnswerBrowser"); }
        catch (ClassNotFoundException missing) { throw new AssertionError("No local answer browser exists yet"); }
        Object browser = type.getDeclaredConstructor().newInstance();
        Method route = type.getDeclaredMethod("route", String.class);
        Method completed = type.getDeclaredMethod("completed", String.class, String.class, String.class);
        Method stop = type.getDeclaredMethod("stopBrowsing");
        Method clear = type.getDeclaredMethod("clear");
        check(route.invoke(browser, "下一页") == null, "List paging must retain its existing route");
        check(((String)route.invoke(browser, "从头浏览")).contains("没有"), "No cached reply must stay local");
        check(((String)route.invoke(browser, "第十段")).contains("没有"), "A jump without a cached answer must never reach Agent");
        check(((String)route.invoke(browser, "下一段")).contains("从头浏览"), "Segment command must not reach Agent outside reading");
        check(route.invoke(browser, "解释从头浏览是什么意思") == null, "Mentioning commands must remain ordinary speech");
        String answer = "开头第一段：苹果和香蕉。\n\n第二段：这是一份已经收到的长回答，需要按顺序读完，不能丢掉前面，也不能漏掉中间。😀\n第三段：最后一个标记是终点。";
        completed.invoke(browser, "普通问题", answer, "idle");
        String first = (String)route.invoke(browser, "请帮我从头浏览。");
        check(body(first).startsWith("开头第一段"), "Reading must restart at the original head");
        check(first.equals(route.invoke(browser, "上一页")), "Previous at first page must not wrap");
        StringBuilder joined = new StringBuilder(content(first));
        String previous = first, next;
        int pages = 1;
        while (!(next = (String)route.invoke(browser, pages % 2 == 1 ? "下一页" : "下一段")).equals(previous)) {
            check(pages++ < 100, "Paging must terminate");
            String last = (String)route.invoke(browser, "上一段");
            check(last.equals(previous), "Backward segment must recover the exact previous page");
            check(next.equals(route.invoke(browser, "下一页")), "Forward alias must recover the exact next page");
            String part = content(next);
            check(!part.isEmpty(), "Pages cannot be empty");
            check(!Character.isLowSurrogate(part.charAt(0)), "Cannot start inside emoji");
            check(!Character.isHighSurrogate(part.charAt(part.length() - 1)), "Cannot end inside emoji");
            joined.append(part); previous = next;
        }
        check(pages > 1 && answer.replace("\n", "").equals(joined.toString()), "Reading all pages must preserve every content character");
        check(first.equals(route.invoke(browser, "从头浏览")), "Restart must reset the cursor");
        stop.invoke(browser);
        check(first.equals(route.invoke(browser, "从头浏览")), "Rewake can retain the same cached answer");
        stop.invoke(browser);
        check(route.invoke(browser, "下一页") == null, "Ending reading must restore list paging");
        check(route.invoke(browser, "列出项目") == null, "Navigation must use the bridge");
        completed.invoke(browser, "列出项目", "项目一、项目二", "control");
        check(route.invoke(browser, "下一页") == null, "List command must leave answer browsing");
        check(((String)route.invoke(browser, "从头浏览")).contains("没有"), "Navigation must invalidate old Agent content");
        completed.invoke(browser, "普通问题", answer, "idle");
        check(route.invoke(browser, "新的问题") == null, "Ordinary questions must leave browsing");
        completed.invoke(browser, "新的问题", "未知错误", "error");
        check(((String)route.invoke(browser, "从头浏览")).contains("没有"), "Failed answers must not replay an older reply");
        completed.invoke(browser, "当前 Agent", "控制信息", "idle");
        check(((String)route.invoke(browser, "从头浏览")).contains("没有"), "Controls must never replace the answer cache");
        completed.invoke(browser, "普通问题", answer, "idle");
        clear.invoke(browser);
        check(((String)route.invoke(browser, "从头浏览")).contains("没有"), "Changing connection must clear the cache");
        System.out.println("answer browser checks passed");
    }
}
