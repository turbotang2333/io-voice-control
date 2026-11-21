package cn.yilu.rayneopaseo;

import java.text.Normalizer;

/** Matches the user's spoken wake phrase without retaining the recognized text. */
final class WakePhraseMatcher {
    private static final String WAKE_PHRASE = "小雷小雷";

    private WakePhraseMatcher() {}

    static boolean matches(String text) {
        if (text == null) return false;
        String normalized = Normalizer.normalize(text, Normalizer.Form.NFKC);
        StringBuilder compact = new StringBuilder(normalized.length());
        normalized.codePoints().forEach(codePoint -> {
            if (!Character.isWhitespace(codePoint) && !isPunctuation(codePoint)) compact.appendCodePoint(codePoint);
        });
        return WAKE_PHRASE.contentEquals(compact);
    }

    private static boolean isPunctuation(int codePoint) {
        int type = Character.getType(codePoint);
        return type == Character.CONNECTOR_PUNCTUATION || type == Character.DASH_PUNCTUATION
            || type == Character.START_PUNCTUATION || type == Character.END_PUNCTUATION
            || type == Character.INITIAL_QUOTE_PUNCTUATION || type == Character.FINAL_QUOTE_PUNCTUATION
            || type == Character.OTHER_PUNCTUATION;
    }
}
