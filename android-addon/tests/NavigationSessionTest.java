package cn.yilu.rayneopaseo;
import java.util.HashMap;
import java.util.Map;

public final class NavigationSessionTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    private static final class Store implements NavigationSession.Store {
        Map<String, Object> values = new HashMap<>();
        int commits;
        boolean broken;
        boolean applyBeforeFailure;
        public synchronized Map<String, ?> read() { return new HashMap<>(values); }
        public synchronized boolean commit(Map<String, Object> changes) {
            if (broken && !applyBeforeFailure) return false;
            for (Map.Entry<String, Object> change : changes.entrySet()) {
                if (change.getValue() == null) values.remove(change.getKey());
                else values.put(change.getKey(), change.getValue());
            }
            if (broken) return false;
            commits++; return true;
        }
    }
    public static void main(String[] args) throws Exception {
        Store store = new Store(); NavigationSession nav = new NavigationSession();
        Thread[] threads = new Thread[12];
        for (int i = 0; i < threads.length; i++) { threads[i] = new Thread(() -> nav.initialize(store)); threads[i].start(); }
        for (Thread thread : threads) thread.join();
        NavigationSession.Snapshot original = nav.current();
        check(original.epoch == 1 && store.commits == 1);
        nav.initialize(store); check(store.commits == 1);
        Map<String, Object> config = new HashMap<>(); config.put("mode", 3);
        store.broken = true;
        try { nav.advance(store, config); throw new AssertionError(); } catch (IllegalStateException expected) {}
        check(!nav.isCurrent(original) && !store.values.containsKey("mode"));
        try { nav.current(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        store.broken = false; nav.advance(store, config);
        check(!nav.isCurrent(original) && nav.current().epoch == 3 && store.values.get("mode").equals(3));
        NavigationSession restarted = new NavigationSession(); restarted.initialize(store);
        check(restarted.current().epoch == 4 && restarted.current().installationId.equals(original.installationId));
        store.values.put("navigation_epoch", 9007199254740991L);
        try { new NavigationSession().initialize(store); throw new AssertionError(); } catch (IllegalStateException expected) {}
        store.values.put("navigation_epoch", -1L);
        try { new NavigationSession().initialize(store); throw new AssertionError(); } catch (IllegalStateException expected) {}
        Store failing = new Store(); failing.broken = true; NavigationSession closed = new NavigationSession();
        try { closed.initialize(failing); throw new AssertionError(); } catch (IllegalStateException expected) {}
        try { closed.current(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        // Android applies changes to memory BEFORE returning commit=false. Even a
        // failing rollback must never expose these unconfirmed values to routing.
        Store android = new Store(); android.values.put("backend", "paseo"); android.values.put("unrelated", "keep");
        NavigationSession guarded = new NavigationSession(); guarded.initialize(android);
        NavigationSession.Snapshot prior = guarded.current();
        android.broken = android.applyBeforeFailure = true;
        Map<String, Object> switched = new HashMap<>(); switched.put("backend", "codex");
        try { guarded.advance(android, switched); throw new AssertionError(); } catch (IllegalStateException expected) {}
        check(!guarded.isCurrent(prior));
        check("paseo".equals(guarded.configuration().get("backend")) && "keep".equals(android.values.get("unrelated")));
        try { guarded.current(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        android.broken = false; guarded.advance(android, switched);
        check(guarded.current().epoch > prior.epoch + 1 && "codex".equals(guarded.configuration().get("backend")));
        Store badStart = new Store(); badStart.values.put("backend", "paseo"); badStart.broken = badStart.applyBeforeFailure = true;
        NavigationSession first = new NavigationSession();
        try { first.initialize(badStart); throw new AssertionError(); } catch (IllegalStateException expected) {}
        first.initialize(badStart);
        check("paseo".equals(first.configuration().get("backend")));
        try { first.current(); throw new AssertionError(); } catch (IllegalStateException expected) {}
        badStart.broken = false; first.advance(badStart, new HashMap<String, Object>());
        check(first.current().epoch == 2);
        System.out.println("navigation session checks passed");
    }
}
