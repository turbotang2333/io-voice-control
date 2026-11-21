package cn.yilu.rayneopaseo;

/** Draft assembled from completed recognition segments. */
public final class ContinuousDraft {
    public enum Kind { NONE, ADDED, SEND, CANCEL }
    public static final class Result {
        public final Kind kind;
        public final String text;
        Result(Kind kind, String text) { this.kind = kind; this.text = text; }
    }
    private final StringBuilder content = new StringBuilder();
    public synchronized Result accept(String text, boolean finished) {
        if (!finished || text == null || text.trim().isEmpty()) return new Result(Kind.NONE, "");
        String segment = text.trim();
        String command = segment.replaceAll("[\\s，。！？；：、,.;!?]+", "");
        if ("取消发送".equals(command)) {
            content.setLength(0);
            return new Result(Kind.CANCEL, "");
        }
        if ("确认发送".equals(command)) {
            if (content.length() == 0) return new Result(Kind.NONE, "");
            String question = content.toString();
            content.setLength(0);
            return new Result(Kind.SEND, question);
        }
        if (content.length() > 0) {
            char end = content.charAt(content.length() - 1), start = segment.charAt(0);
            if (!Character.isWhitespace(end) && !Character.isWhitespace(start)
                && "，。！？；：、,.;!?".indexOf(end) < 0 && "，。！？；：、,.;!?".indexOf(start) < 0) content.append('，');
        }
        content.append(segment);
        return new Result(Kind.ADDED, "");
    }
    public synchronized String snapshot() { return content.toString(); }
    public synchronized void reset() { content.setLength(0); }
}
