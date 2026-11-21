package cn.yilu.rayneopaseo;

/** Collects explicit-command input and hands it to the existing reply gate once. */
final class NativeInputTrial {
    private final ContinuousDraft draft = new ContinuousDraft();
    private Object owner;
    private volatile boolean active;
    private boolean inputFinished, backgroundInput, replyStarted, voiceControls, exitRequested;
    private long secondaryWakeAt = -1;
    private String question = "", lastIdentity = "", pendingCommandDisplay = "";
    private InteractionPreferences nextPreferences = InteractionPreferences.defaults(), preferences = nextPreferences;
    private boolean preferencesBound;
    private ShortcutBindings nextShortcuts = ShortcutBindings.empty(), shortcuts = nextShortcuts;
    private ShortcutBindings.Entry shortcut;
    private String inputHint = "";
    void configureShortcuts(ShortcutBindings next) { if (next == null) throw new IllegalArgumentException(); nextShortcuts = next; }
    ShortcutBindings.Entry shortcut() { return shortcut; }
    String takeInputHint() { String value = inputHint; inputHint = ""; return value; }
    private String localHint = "";
    void configure(InteractionPreferences next) { if (next == null) throw new IllegalArgumentException(); nextPreferences = next; }
    InteractionPreferences preferences() { return preferences; }
    String localHint() { return localHint; }
    void arm() { arm(false); }
    void arm(boolean controls) { stop(); voiceControls = controls; active = true; }
    void stop() { active = inputFinished = backgroundInput = replyStarted = voiceControls = exitRequested = false; preferencesBound = false; owner = null; shortcut = null; inputHint = ""; question = lastIdentity = pendingCommandDisplay = localHint = ""; secondaryWakeAt = -1; draft.reset(); }
    Object source() { return owner; }
    boolean bind(Object source) {
        if (!active || source == null || (owner != null && owner != source)) return false;
        owner = source;
        return true;
    }
    boolean owns(Object source) { return active && owner != null && owner == source; }
    boolean active() { return active; }
    void observeTransportExit(int reason, long now) {
        // Stock 1.0.6 ExitBean rc=15 means SECONDARY_WAKE_UP. A real exit,
        // stop, or expired notice must never restore another conversation.
        secondaryWakeAt = reason == 15 && active && voiceControls && !inputFinished
            && !replyStarted && !exitRequested && draftLength() > 0 ? now : -1;
    }
    boolean resumeAfterSecondaryWake(long now) {
        long wakeAt = secondaryWakeAt;
        secondaryWakeAt = -1;
        if (wakeAt < 0 || now < wakeAt || now - wakeAt > 5000 || !active || !voiceControls
            || inputFinished || replyStarted || exitRequested || draftLength() == 0) return false;
        // Retain the completed draft, but rebind to the new capture stream.
        // The integration retires the previous listener until audioStart.
        owner = null;
        backgroundInput = false;
        lastIdentity = pendingCommandDisplay = "";
        return true;
    }
    boolean inputFinished() { return inputFinished; }
    String question() { return question; }
    boolean exitRequested() { return exitRequested; }
    boolean nextTurn(Object source) {
        if (!owns(source) || !inputFinished || exitRequested) return false;
        inputFinished = replyStarted = false;
        backgroundInput = true;
        question = lastIdentity = pendingCommandDisplay = localHint = "";
        preferencesBound = false;
        shortcut = null; inputHint = "";
        draft.reset();
        return true;
    }
    String takeCommandDisplay() {
        String command = pendingCommandDisplay;
        pendingCommandDisplay = "";
        return command;
    }
    boolean replyStarted() { return replyStarted; }
    long beginReply(TurnGate gate, String session) {
        if (!active || !inputFinished || replyStarted || question.isEmpty()) return -1;
        gate.reset();
        gate.recognize(owner, question, true, session);
        long generation = gate.beginReply(owner, session);
        if (generation >= 0) replyStarted = true;
        return generation;
    }
    int draftLength() { return draft.snapshot().length(); }
    boolean useBackground(Object source) {
        if (!owns(source) || inputFinished) return false;
        backgroundInput = true;
        return true;
    }
    boolean accept(Object source, String text, boolean finished, String session) {
        return accept(source, text, finished, session, false);
    }
    boolean acceptBackground(Object source, String text, boolean finished, String session) {
        if (!backgroundInput) return false;
        return accept(source, text, finished, session, true);
    }
    private boolean accept(Object source, String text, boolean finished, String session, boolean background) {
        if (!active || source == null || (owner != null && owner != source)) return false;
        // Native callbacks can continue after the background task takes over.
        // Ignore that stream, rather than dropping legitimate repeated words.
        if (backgroundInput != background) return true;
        if (text == null || text.trim().isEmpty()) return true;
        if (!preferencesBound) { preferences = nextPreferences; shortcuts = nextShortcuts; preferencesBound = true; }
        owner = source;
        if (!finished) return true;
        if (voiceControls && !inputFinished) {
            ShortcutBindings.Entry matched = shortcuts.match(text);
            if (matched != null) {
                if (!draft.snapshot().isEmpty()) {
                    inputHint = "还有未发送内容，请先确认发送或取消发送，再切换。"; return true;
                }
                shortcut = matched; question = text.trim(); inputFinished = true;
                if (background) pendingCommandDisplay = text.trim();
                return true;
            }
        }
        InteractionPreferences.Resolution resolved = preferences.resolve(text);
        String accepted = text;
        if (voiceControls && (draft.snapshot().isEmpty() || "confirm".equals(resolved.action)
            || "cancel".equals(resolved.action) || "exit".equals(resolved.action)
            || (VoiceCommand.samePending(draft.snapshot(), resolved.text)
                && ("search".equals(resolved.action) || "create".equals(resolved.action))))) {
            if (!resolved.hint.isEmpty()) {
                localHint = resolved.hint; question = ""; inputFinished = true;
                if (background) pendingCommandDisplay = text.trim();
                return true;
            }
            accepted = resolved.text;
        }
        if (voiceControls && VoiceCommand.isExit(accepted)) {
            question = "";
            inputFinished = exitRequested = true;
            if (background) pendingCommandDisplay = text.trim();
            return true;
        }
        if (inputFinished) return true;
        String identity = session + "\n" + text;
        if (identity.equals(lastIdentity)) return true;
        lastIdentity = identity;
        if (voiceControls && VoiceCommand.isBarePending(draft.snapshot())) {
            String command = accepted.replaceAll("[\\s，。！？；：、,.;!?]+", "");
            if ((VoiceCommand.samePending(draft.snapshot(), accepted) && VoiceCommand.isBarePending(accepted)) || "确认发送".equals(command)) return true;
            if (VoiceCommand.samePending(draft.snapshot(), accepted)) draft.reset();
        }
        if (voiceControls && draft.snapshot().isEmpty() && VoiceCommand.isBarePending(accepted)) {
            draft.accept(VoiceCommand.isBareCreate(accepted) ? "新建对话" : "查找对话", true);
            return true;
        }
        if (voiceControls && draft.snapshot().isEmpty() && VoiceCommand.isControl(accepted)) {
            question = accepted.trim();
            inputFinished = true;
            if (background) pendingCommandDisplay = text.trim();
            return true;
        }
        ContinuousDraft.Result result = draft.accept(accepted, true);
        if (result.kind == ContinuousDraft.Kind.SEND || result.kind == ContinuousDraft.Kind.CANCEL) {
            question = result.text;
            inputFinished = true;
            if (background) {
                String command = result.kind == ContinuousDraft.Kind.SEND ? "确认发送" : "取消发送";
                pendingCommandDisplay = VoiceCommand.normalize(text).equals(command) ? command : text.trim();
            }
        }
        return true;
    }
}
