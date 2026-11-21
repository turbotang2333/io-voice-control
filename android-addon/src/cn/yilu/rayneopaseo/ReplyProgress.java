package cn.yilu.rayneopaseo;

/** One request's lens-only labels. Never combines status with the cached reply. */
final class ReplyProgress {
    private final boolean enabled, search, creation;
    private final InteractionPreferences preferences;
    private boolean working, tool, permission, searching, creating, finished;

    static ReplyProgress forBackend(String backend, boolean search, boolean creation, InteractionPreferences preferences) {
        return new ReplyProgress("paseo".equals(backend) || "codex".equals(backend), search, creation, preferences);
    }

    ReplyProgress(boolean enabled, boolean search) { this(enabled, search, InteractionPreferences.defaults()); }
    ReplyProgress(boolean enabled, boolean search, InteractionPreferences preferences) {
        this(enabled, search, false, preferences);
    }
    ReplyProgress(boolean enabled, boolean search, boolean creation, InteractionPreferences preferences) {
        this.enabled = enabled; this.search = search; this.creation = creation; this.preferences = preferences;
    }

    String state(String state) {
        if (!enabled || finished) return "";
        if (creation) {
            if (!"creating".equals(state) || creating) return "";
            creating = true; return preferences.text("creating");
        }
        if (search) {
            if (!"searching".equals(state) || searching) return "";
            searching = true;
            return preferences.text("searching");
        }
        if ("working".equals(state) && !working) {
            working = true;
            return preferences.text("working");
        }
        if ("tool".equals(state) && !tool) {
            tool = true;
            return preferences.text("tool");
        }
        if ("permission".equals(state) && !permission) {
            permission = true;
            return preferences.text("approval");
        }
        return "";
    }

    String finish(String outcome) {
        if (finished) return "";
        finished = true;
        return enabled && !search && !creation && "idle".equals(outcome) ? preferences.text("complete") : "";
    }
}
