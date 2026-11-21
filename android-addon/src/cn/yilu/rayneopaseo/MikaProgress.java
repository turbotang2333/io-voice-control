package cn.yilu.rayneopaseo;

import java.util.ArrayList;
import java.util.List;

/** Tracks only actions observed in the task record, never raw screen contents. */
final class MikaProgress {
    private int lastStep;
    private final List<String> pending = new ArrayList<>();

    void action(int step, String reason, String effect) {
        if (step <= lastStep) return;
        lastStep = step;
        if (reason == null) return;
        String text = reason.split("[\\r\\n]", 2)[0].trim();
        if (text.isEmpty()) return;
        if (text.length() > 60) text = text.substring(0, 60) + "…";
        if ("no_effect".equals(effect)) text += "，页面无明显变化";
        if (!text.endsWith("。") && !text.endsWith("！") && !text.endsWith("…")) text += "。";
        pending.add(text);
    }

    List<String> take() {
        List<String> out = new ArrayList<>(pending);
        pending.clear();
        return out;
    }
}
