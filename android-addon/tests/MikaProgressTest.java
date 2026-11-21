package cn.yilu.rayneopaseo;
import java.util.List;

public final class MikaProgressTest {
    private static void check(boolean v) { if (!v) throw new AssertionError(); }
    public static void main(String[] args) {
        MikaProgress tracker = new MikaProgress();
        tracker.action(1, "打开淘宝查找闪购奶茶", "completed");
        tracker.action(2, "进入淘宝闪购", "done");
        tracker.action(3, "查看店内奶茶及销量排序", "no_effect");
        List<String> first = tracker.take();
        check(first.size() == 3 && first.get(0).contains("打开淘宝") && first.get(2).contains("无明显变化"));
        tracker.action(2, "进入淘宝闪购", "done");
        check(tracker.take().isEmpty());
        tracker.action(4, "选择最低糖度\n隐藏第二行", "small_change");
        check(tracker.take().get(0).equals("选择最低糖度。"));
        tracker.action(5, "", "done");
        check(tracker.take().isEmpty());
        System.out.println("Mika progress checks passed");
    }
}
