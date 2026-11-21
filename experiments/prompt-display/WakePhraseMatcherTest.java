package cn.yilu.rayneopaseo;

import java.lang.reflect.Method;

public final class WakePhraseMatcherTest {
    private static void check(Method matches, String phrase, boolean expected) throws Exception {
        boolean actual = (Boolean) matches.invoke(null, phrase);
        if (actual != expected) throw new AssertionError("unexpected match for " + phrase);
    }

    public static void main(String[] args) throws Exception {
        Method matches;
        try {
            matches = Class.forName("cn.yilu.rayneopaseo.WakePhraseMatcher").getDeclaredMethod("matches", String.class);
            matches.setAccessible(true);
        } catch (ReflectiveOperationException missing) {
            throw new AssertionError("wake phrase should match exactly", missing);
        }
        check(matches, "小雷小雷", true);
        check(matches, "小雷，小雷！", true);
        check(matches, " 小雷 小雷 ", true);
        check(matches, "小雷小雷吗", false);
        check(matches, "你好小雷小雷", false);
        check(matches, null, false);
        System.out.println("6 wake phrase checks passed");
    }
}
