package cn.yilu.rayneopaseo;

public final class PromptDisplayTrialStateTest {
    private static int checks;
    private static void check(boolean condition) { checks++; if (!condition) throw new AssertionError("check " + checks); }
    private static PromptDisplayTrialState trial(PromptDisplayTrialState.Route route) {
        return new PromptDisplayTrialState("current-session", route, 1000);
    }
    public static void main(String[] args) {
        PromptDisplayTrialState state = trial(PromptDisplayTrialState.Route.PROMPT);
        check(state.nextFrame(1000) == -1);
        check(!state.locallyQueuedFrame(0, 1000));
        check(!state.acknowledge("AI_SUBTITLE", "current-session", 1, 1001));
        check(!state.acknowledge("PROACTIVE_AI", "old-session", 1, 1001));
        state.observeUnboundAudio("PROACTIVE_AI", 4);
        check(state.unboundAudioPackets() == 0);
        check(!state.expired(8999));
        check(state.acknowledge("PROACTIVE_AI", "current-session", 1, 2000));
        check(!state.acknowledge("PROACTIVE_AI", "current-session", 1, 2001));
        check(!state.acknowledge("PROACTIVE_AI", "current-session", 0, 2001));
        check(state.accepted());
        check(state.nextFrame(2000) == 0);
        check(!state.locallyQueuedFrame(1, 2000));
        check(state.locallyQueuedFrame(0, 2000));
        check(!state.locallyQueuedFrame(0, 2000));
        check(state.nextFrame(15999) == -1);
        check(state.nextFrame(16000) == 1);
        check(state.locallyQueuedFrame(1, 16000));
        check(state.locallyQueuedFrame(2, 31000));
        check(state.nextFrame(46000) == -1);
        check(state.frames() == 3);
        state.observeUnboundAudio("VOICE_ASSISTANT", 3);
        state.observeUnboundAudio("AI_SUBTITLE", 4);
        state.observeUnboundAudio("PROACTIVE_AI", 2);
        state.observeUnboundAudio("PROACTIVE_AI", 4);
        check(state.unboundAudioPackets() == 1);
        check(!state.remoteExit("AI_SUBTITLE", "current-session"));
        check(!state.remoteExit("PROACTIVE_AI", "old-session"));
        check(state.expired(61000));
        check(state.close());
        check(!state.close());
        check(!state.accepted() && state.pageAcknowledged());
        state.observeUnboundAudio("PROACTIVE_AI", 4);
        check(state.unboundAudioPackets() == 1);
        check(state.nextFrame(31000) == -1);

        PromptDisplayTrialState timedOut = trial(PromptDisplayTrialState.Route.PROMPT);
        check(timedOut.expired(9000));
        check(!timedOut.acknowledge("PROACTIVE_AI", "current-session", 1, 9000));
        check(!timedOut.accepted());
        check(timedOut.expired(999));
        PromptDisplayTrialState rejected = trial(PromptDisplayTrialState.Route.PROMPT);
        check(!rejected.acknowledge("PROACTIVE_AI", "current-session", -1, 2000));
        check(rejected.closed());
        check(!rejected.acknowledge("PROACTIVE_AI", "current-session", 1, 2001));
        PromptDisplayTrialState hybrid = trial(PromptDisplayTrialState.Route.CAPTION_OVER_PROMPT);
        check(hybrid.acknowledge("PROACTIVE_AI", "current-session", 1, 2000));
        check(hybrid.remoteExit("AI_SUBTITLE", "current-session"));
        check(hybrid.closed());
        check(!hybrid.remoteExit("PROACTIVE_AI", "current-session"));
        check(hybrid.nextFrame(2100) == -1);
        System.out.println(checks + " prompt display lifecycle checks passed");
    }
}
