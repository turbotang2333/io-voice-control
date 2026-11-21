package cn.yilu.rayneopaseo;

public final class NativeInputTrialTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    public static void main(String[] args) {
        NativeInputTrial trial = new NativeInputTrial();
        Object source = new Object(), other = new Object();
        check(!trial.accept(source, "苹果", true, "a"));
        trial.arm();
        check(trial.accept(source, "苹", false, "a"));
        check(!trial.accept(other, "不应混入", true, "b"));
        check(trial.accept(source, "苹果", true, "a"));
        check(trial.accept(source, "苹果", true, "a"));
        check(trial.accept(source, "香蕉", true, "after-long-pause"));
        check(!trial.inputFinished());
        check(trial.accept(source, "确认发送", true, "send"));
        check(trial.inputFinished());
        check("苹果，香蕉".equals(trial.question()));
        check(trial.accept(source, "重复回调", true, "late"));
        check("苹果，香蕉".equals(trial.question()));
        trial.stop();
        check(!trial.owns(source));
        trial.arm();
        check(trial.accept(other, "确认发送", true, "empty"));
        check(!trial.inputFinished());
        check(trial.accept(other, "请解释确认发送是什么意思", true, "body"));
        check(!trial.inputFinished());
        check(trial.accept(other, "取消发送。", true, "cancel"));
        check(trial.inputFinished());
        check(trial.question().isEmpty());

        // The native recognizer can report the same utterance after the background
        // recognizer. Once handed over, only the latter owns draft updates.
        trial.arm();
        check(!trial.acceptBackground(source, "不应混入", true, "early"));
        check(trial.accept(source, "苹果", true, "initial"));
        check(!trial.useBackground(other));
        check(trial.useBackground(source));
        check(trial.takeCommandDisplay().isEmpty());
        check(trial.acceptBackground(source, "香蕉", true, "background-0"));
        check(trial.accept(source, "香蕉", true, "native-duplicate"));
        check(trial.draftLength() == "苹果，香蕉".length());
        check(trial.accept(source, "确认发送", true, "native-command"));
        check(!trial.inputFinished());
        // Real repeated words must survive; do not deduplicate by text alone.
        check(trial.accept(source, "香蕉", true, "native-first"));
        check(trial.acceptBackground(source, "香蕉", true, "background-1"));
        check(!trial.acceptBackground(other, "不应混入", true, "foreign"));
        check(trial.acceptBackground(source, "确认发送", true, "background-2"));
        check("确认发送".equals(trial.takeCommandDisplay()));
        check(trial.takeCommandDisplay().isEmpty());
        check("苹果，香蕉，香蕉".equals(trial.question()));
        trial.stop();
        trial.arm();
        check(trial.accept(source, "重新开始", true, "reset"));
        check(trial.accept(source, "确认发送", true, "reset-send"));
        check("重新开始".equals(trial.question()));

        // Holding input must not create a network turn. Only an explicit send can
        // hand the complete draft to the existing reply gate, exactly once.
        TurnGate reply = new TurnGate();
        trial.arm();
        check(trial.accept(source, "请依次复述", true, "intro"));
        check(trial.beginReply(reply, "request-1") == -1);
        check(reply.beginReply(source, "request-1") == -1);
        check(trial.useBackground(source));
        check(trial.acceptBackground(source, "苹果", true, "background-0"));
        check(trial.accept(source, "苹果", true, "native-duplicate"));
        check(trial.acceptBackground(source, "香蕉", true, "background-1"));
        check(trial.beginReply(reply, "request-1") == -1);
        check(trial.acceptBackground(source, "确认发送", true, "background-2"));
        long generation = trial.beginReply(reply, "request-1");
        check(generation >= 0 && reply.accepts(generation));
        check("请依次复述，苹果，香蕉".equals(reply.question()));
        check("request-1".equals(reply.session()));
        check(trial.beginReply(reply, "duplicate-completion") == -1);
        check(reply.accepts(generation));
        check(reply.complete(generation));
        check(trial.beginReply(reply, "late-completion") == -1);
        trial.stop();
        trial.arm();
        check(trial.accept(source, "不发送", true, "cancel-body"));
        check(trial.accept(source, "取消发送", true, "cancel-command"));
        check(trial.beginReply(reply, "cancelled") == -1);
        check(trial.takeCommandDisplay().isEmpty());
        trial.stop();
        trial.arm();
        check(trial.accept(source, "待取消", true, "initial"));
        check(trial.useBackground(source));
        check(trial.acceptBackground(source, "取消发送。", false, "partial"));
        check(trial.takeCommandDisplay().isEmpty());
        check(trial.acceptBackground(source, "取消发送。", true, "finished"));
        check("取消发送".equals(trial.takeCommandDisplay()));
        check(trial.takeCommandDisplay().isEmpty());
        trial.stop();
        trial.arm(true);
        check(trial.accept(source, "列出项目。", true, "list"));
        check(trial.inputFinished());
        check("列出项目。".equals(trial.question()));
        check(trial.beginReply(reply, "navigation") >= 0);
        // Mentioning a command inside a question must not switch conversations.
        trial.stop();
        trial.arm(true);
        check(trial.accept(source, "请解释选择 Agent是什么意思", true, "body"));
        check(trial.useBackground(source));
        check(trial.acceptBackground(source, "选择 1", true, "quoted"));
        check(!trial.inputFinished());
        check(trial.acceptBackground(source, "确认发送", true, "send-body"));
        check("请解释选择 Agent是什么意思，选择 1".equals(trial.question()));
        for (String command : new String[]{"进入对话", "当前 Agent", "下一页", "选择 2", "请帮我选择五", "Agent 列表", "当前项目", "列出 Agent", "选择 ６"}) {
            check(VoiceCommand.isControl(command));
        }
        check(!VoiceCommand.isControl("请解释当前 Agent是什么意思"));
        check(!VoiceCommand.isControl("选择文章 Agent"));
        check(!VoiceCommand.isControl("当前助手"));
        // A numbered choice inside a draft stays text; cancel then choose starts
        // navigation without handing the cancelled draft to the network gate.
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "这是草稿", true, "draft-before-choice"));
        check(trial.useBackground(source));
        check(trial.acceptBackground(source, "选择 2", true, "held-choice"));
        check(!trial.inputFinished());
        check(trial.acceptBackground(source, "取消发送", true, "discard-choice"));
        check(trial.question().isEmpty() && trial.beginReply(reply, "discarded") == -1);
        check(trial.nextTurn(source));
        check(trial.acceptBackground(source, "选择 2", true, "fresh-choice"));
        check(trial.inputFinished() && "选择 2".equals(trial.question()));
        check(trial.beginReply(reply, "choice") >= 0);
        // A conversation keeps the same microphone/listener across replies.
        trial.stop(); trial.arm(true);
        check(trial.bind(source));
        check(!trial.bind(other));
        check(trial.accept(source, "当前 Agent", true, "first-turn"));
        long firstReply = trial.beginReply(reply, "first-reply");
        check(firstReply >= 0);
        check(!trial.nextTurn(other));
        check(reply.complete(firstReply));
        check(trial.nextTurn(source));
        check(trial.owns(source) && !trial.inputFinished() && !trial.replyStarted());
        check(trial.accept(source, "原生迟到内容", true, "stale-native"));
        check(trial.draftLength() == 0);
        check(trial.acceptBackground(source, "列出 Agent", true, "next-command"));
        check(trial.inputFinished());
        check("列出 Agent".equals(trial.question()));
        long secondReply = trial.beginReply(reply, "second-reply");
        check(secondReply > firstReply && !reply.accepts(firstReply));
        check(reply.complete(secondReply));
        check(trial.nextTurn(source));
        check(trial.acceptBackground(source, "需要取消的草稿", true, "draft"));
        check(trial.acceptBackground(source, "取消发送", true, "cancel"));
        check(trial.question().isEmpty() && !trial.exitRequested());
        check(trial.nextTurn(source));
        check(trial.acceptBackground(source, "需要提交的问题", true, "question"));
        check(trial.acceptBackground(source, "确认发送", true, "send"));
        check(trial.beginReply(reply, "pending") >= 0);
        // Exiting the glasses session never submits an extra message, even while
        // an already submitted Agent task is still running.
        check(trial.acceptBackground(source, "结束对话。", true, "exit"));
        check(trial.exitRequested() && trial.question().isEmpty());
        check(trial.beginReply(reply, "must-not-send") == -1);
        check(!trial.nextTurn(source));
        // A secondary wake can interrupt a long draft without any user command.
        // Rebuilding capture must retain completed segments and wait for send.
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "前段正文", true, "native-before"));
        check(trial.useBackground(source));
        StringBuilder prefix = new StringBuilder("前段正文");
        for (int i = 0; i < 80; i++) {
            check(trial.acceptBackground(source, "追加前文", true, "before-" + i));
            prefix.append("，追加前文");
        }
        trial.observeTransportExit(15, 1000);
        check(trial.resumeAfterSecondaryWake(1020));
        check(trial.draftLength() == prefix.length());
        check(!trial.inputFinished() && !trial.replyStarted());
        check(!trial.acceptBackground(source, "旧识别尾包", true, "old-background"));
        check(trial.bind(other));
        check(!trial.accept(source, "旧监听器尾包", true, "old-native"));
        check(trial.accept(other, "后段正文", true, "new-native"));
        check(trial.beginReply(reply, "not-confirmed") == -1);
        check(trial.useBackground(other));
        check(trial.acceptBackground(other, "确认发送", true, "new-send"));
        check((prefix + "，后段正文").equals(trial.question()));
        long resumedReply = trial.beginReply(reply, "resumed-send");
        check(resumedReply >= 0 && reply.accepts(resumedReply));
        check(trial.beginReply(reply, "resumed-duplicate") == -1);
        trial.observeTransportExit(15, 2000);
        check(!trial.resumeAfterSecondaryWake(2020));
        check(reply.accepts(resumedReply));

        // A wake notice is single-use and cannot survive other exits or stop.
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "保留正文", true, "body"));
        trial.observeTransportExit(15, 3000);
        check(trial.resumeAfterSecondaryWake(3020));
        check(!trial.resumeAfterSecondaryWake(3040));
        check(trial.bind(source));
        check(trial.accept(source, "同样短句", true, "reused-session"));
        trial.observeTransportExit(15, 4000);
        check(trial.resumeAfterSecondaryWake(4020));
        check(trial.accept(source, "同样短句", true, "reused-session"));
        check(trial.accept(source, "确认发送", true, "send"));
        check("保留正文，同样短句，同样短句".equals(trial.question()));
        for (int reason : new int[]{0, 3, 6, 7}) {
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "旧对话", true, "body"));
            trial.observeTransportExit(15, 5000);
            trial.observeTransportExit(reason, 5010);
            check(!trial.resumeAfterSecondaryWake(5020));
            trial.arm(true);
            check(trial.draftLength() == 0);
        }
        for (long when : new long[]{5999, 11001}) {
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "过期唤醒不得复用", true, "body"));
            trial.observeTransportExit(15, 6000);
            check(!trial.resumeAfterSecondaryWake(when));
        }
        trial.stop(); trial.arm(true);
        check(!trial.resumeAfterSecondaryWake(7000));
        check(trial.accept(source, "已停止正文", true, "body"));
        trial.observeTransportExit(15, 7000); trial.stop();
        check(!trial.resumeAfterSecondaryWake(7020));
        trial.arm(false);
        check(trial.accept(source, "本地回显模式", true, "body"));
        trial.observeTransportExit(15, 8000);
        check(!trial.resumeAfterSecondaryWake(8020));
        for (String control : new String[]{"取消发送", "结束对话"}) {
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "不应恢复的正文", true, "body"));
            trial.observeTransportExit(15, 9000);
            check(trial.accept(source, control, true, "control"));
            check(!trial.resumeAfterSecondaryWake(9020));
            check(trial.question().isEmpty());
        }
        for (String control : new String[]{"取消发送", "结束对话"}) {
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "唤醒前草稿", true, "body"));
            trial.observeTransportExit(15, 10000);
            check(trial.resumeAfterSecondaryWake(10020));
            check(trial.accept(other, control, true, "new-control"));
            check(trial.question().isEmpty());
            check(trial.beginReply(reply, "must-still-not-send") == -1);
        }
        // Recent navigation is immediate only as a complete utterance with an empty draft.
        for (String command : new String[]{"最近对话", "列出最近对话", "请帮我列出最近对话。"}) {
            check(VoiceCommand.isControl(command));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, command, false, "recent-partial"));
            check(!trial.inputFinished());
            check(trial.accept(source, command, true, "recent-final"));
            check(trial.inputFinished() && command.equals(trial.question()));
            check(trial.beginReply(reply, "recent-control") >= 0);
            trial.stop(); trial.arm(true);
            check(trial.bind(source) && trial.useBackground(source));
            check(trial.acceptBackground(source, command, true, "recent-background"));
            check(trial.inputFinished() && command.equals(trial.question()));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "已有正文", true, "recent-draft"));
            check(trial.useBackground(source));
            check(trial.acceptBackground(source, command, true, "recent-in-draft"));
            check(!trial.inputFinished() && trial.beginReply(reply, "must-not-auto-send") == -1);
            check(trial.acceptBackground(source, "确认发送", true, "recent-confirm"));
            check(("已有正文，" + command).equals(trial.question()));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "先取消的草稿", true, "recent-before-cancel"));
            check(trial.accept(source, "取消发送", true, "recent-cancel"));
            check(trial.question().isEmpty() && trial.beginReply(reply, "recent-cancelled") == -1);
            check(trial.nextTurn(source));
            check(trial.acceptBackground(source, command, true, "recent-after-cancel"));
            check(trial.inputFinished() && command.equals(trial.question()));
            trial.stop(); trial.arm(false);
            check(trial.accept(source, command, true, "recent-local-echo"));
            check(!trial.inputFinished());
        }
        check(!VoiceCommand.isControl("请解释最近对话是什么意思"));
        // Reading commands execute locally only when no unsent draft exists.
        for (String command : new String[]{"从头浏览", "下一段", "上一段", "下一页", "上一页", "请帮我从头浏览。",
            "第十段", "第 10 段", "跳到第二十一页", "请帮我跳转到第三段。", "第０段", "第999999999999999999段"}) {
            check(VoiceCommand.isControl(command));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, command, false, "reading-partial"));
            check(!trial.inputFinished());
            check(trial.accept(source, command, true, "reading-final"));
            check(trial.inputFinished() && command.equals(trial.question()));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "请解释这段文字", true, "reading-draft"));
            check(trial.accept(source, command, true, "reading-in-draft"));
            check(!trial.inputFinished());
            check(trial.accept(source, "确认发送", true, "reading-send"));
            check(("请解释这段文字，" + command).equals(trial.question()));
        }
        check(!VoiceCommand.isControl("请解释从头浏览是什么意思"));
        check(!VoiceCommand.isControl("第十段是什么意思"));
        check(!VoiceCommand.isControl("请解释第十段的内容"));
        for (String command : new String[]{"查找对话PROJECTDELTA身份认证相关", "请帮我查找对话示例工作台安卓 APP 推送。", "查询对话PROJECTDELTA身份认证相关"}) {
            check(!VoiceCommand.isControl(command));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, command, false, "search-partial"));
            check(!trial.inputFinished());
            check(trial.accept(source, command, true, "search-final"));
            check(!trial.inputFinished() && trial.beginReply(reply, "search-must-wait-for-confirm") == -1);
            check(trial.accept(source, "确认发送", true, "search-final-confirm"));
            check(trial.inputFinished() && command.equals(trial.question()));
            trial.stop(); trial.arm(true);
            check(trial.accept(source, "草稿正文", true, "search-draft"));
            check(trial.accept(source, command, true, "search-in-draft"));
            check(!trial.inputFinished());
            check(trial.accept(source, "确认发送", true, "search-confirm"));
            check(("草稿正文，" + command).equals(trial.question()));
        }
        check(!VoiceCommand.isControl("请解释查找对话这个功能"));
        check(VoiceCommand.searchBlocked("查找对话", false));
        check(VoiceCommand.searchBlocked("请帮我查找对话PROJECTDELTA身份认证相关。", false));
        check(!VoiceCommand.searchBlocked("查找对话PROJECTDELTA身份认证相关", true));
        check(!VoiceCommand.searchBlocked("普通问题", false));
        check(VoiceCommand.searchBlocked("查询对话PROJECTDELTA身份认证相关", false));
        check(!VoiceCommand.searchBlocked("查询对话PROJECTDELTA身份认证相关", true));
        check(!VoiceCommand.searchBlocked("请解释查询对话这个功能", false));
        for (boolean background : new boolean[]{false, true}) {
          for (String searchPrefix : new String[]{"查找对话", "查询对话"}) {
            trial.stop(); trial.arm(true);
            if (background) check(trial.bind(source) && trial.useBackground(source));
            check(!VoiceCommand.isControl("查找对话"));
            check(background ? trial.acceptBackground(source, searchPrefix, true, "bare-local")
                : trial.accept(source, searchPrefix, true, "bare-local"));
            check(!trial.inputFinished() && trial.question().isEmpty() && trial.draftLength() == 4);
            check(trial.beginReply(reply, "bare-must-stay-local") == -1);
            check(background ? trial.acceptBackground(source, "确认发送", true, "bare-confirm")
                : trial.accept(source, "确认发送", true, "bare-confirm"));
            check(!trial.inputFinished() && trial.draftLength() == 4);
            check(background ? trial.acceptBackground(source, "取消发送", true, "bare-cancel")
                : trial.accept(source, "取消发送", true, "bare-cancel"));
            check(trial.inputFinished() && trial.question().isEmpty() && trial.draftLength() == 0);
            trial.stop(); trial.arm(true);
            if (background) check(trial.bind(source) && trial.useBackground(source));
            check(background ? trial.acceptBackground(source, searchPrefix, true, "split-prefix")
                : trial.accept(source, searchPrefix, true, "split-prefix"));
            check(background ? trial.acceptBackground(source, "PROJECTDELTA", true, "split-project")
                : trial.accept(source, "PROJECTDELTA", true, "split-project"));
            check(!trial.inputFinished() && trial.beginReply(reply, "split-must-wait") == -1);
            check(background ? trial.acceptBackground(source, "身份认证相关", true, "split-topic")
                : trial.accept(source, "身份认证相关", true, "split-topic"));
            check(!trial.inputFinished());
            check(background ? trial.acceptBackground(source, "确认发送", true, "split-search-confirm")
                : trial.accept(source, "确认发送", true, "split-search-confirm"));
            check(trial.inputFinished() && "查找对话，PROJECTDELTA，身份认证相关".equals(trial.question()));
          }
        }
        java.util.Map<String, String> overrides = new java.util.HashMap<>();
        overrides.put("alias.confirm", "发给助手"); overrides.put("alias.cancel", "清空草稿");
        overrides.put("alias.search", "搜索聊天"); overrides.put("alias.browse_first", "回到开头");
        overrides.put("alias.select", "切到{数字}");
        InteractionPreferences configured = InteractionPreferences.defaults().withChanges(overrides);
        trial.configure(configured); trial.stop(); trial.arm(true);
        check(trial.accept(source, "搜索聊天", true, "custom-prefix"));
        check(trial.accept(source, "发给助手", true, "custom-bare-confirm"));
        check(!trial.inputFinished() && trial.draftLength() == 4);
        check(trial.accept(source, "PROJECTDELTA身份认证", true, "custom-topic"));
        check(trial.accept(source, "发给助手", false, "custom-partial-send"));
        check(!trial.inputFinished());
        check(trial.accept(source, "发给助手", true, "custom-send"));
        check("查找对话，PROJECTDELTA身份认证".equals(trial.question()));
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "第一段正文", false, "freeze-partial"));
        trial.configure(InteractionPreferences.defaults());
        check(trial.accept(source, "第一段正文", true, "freeze-final"));
        check(trial.accept(source, "回到开头", true, "body-not-control"));
        check(!trial.inputFinished());
        check(trial.accept(source, "发给助手", true, "frozen-confirm"));
        check("第一段正文，回到开头".equals(trial.question()));
        check(trial.nextTurn(source));
        check(trial.acceptBackground(source, "发给助手", true, "next-round-default"));
        check(!trial.inputFinished()); // The removed custom confirm is ordinary content next round.
        check(trial.acceptBackground(source, "取消发送", true, "cancel-old-alias-body"));
        check(trial.question().isEmpty());
        trial.configure(configured); trial.stop(); trial.arm(true);
        check(trial.accept(source, "回到开头", true, "custom-immediate"));
        check(trial.inputFinished() && "从头浏览".equals(trial.question()));
        check(trial.nextTurn(source));
        check(trial.acceptBackground(source, "切到那个", true, "custom-invalid"));
        check(trial.inputFinished() && trial.question().isEmpty() && !trial.localHint().isEmpty());
        check(trial.beginReply(reply, "invalid-never-agent") == -1);
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "普通草稿", true, "custom-cancel-draft"));
        check(trial.accept(source, "清空草稿", true, "custom-cancel"));
        check(trial.question().isEmpty());
        java.util.Map<String, String> creationWords = new java.util.HashMap<>();
        creationWords.put("alias.create", "新增聊天");
        InteractionPreferences createPreferences = InteractionPreferences.defaults().withChanges(creationWords);
        for (boolean background : new boolean[]{false, true}) {
          for (String creationPrefix : new String[]{"新建对话", "新增聊天"}) {
            trial.configure(createPreferences); trial.stop(); trial.arm(true);
            if (background) check(trial.bind(source) && trial.useBackground(source));
            check(background ? trial.acceptBackground(source, creationPrefix, true, "create-prefix") : trial.accept(source, creationPrefix, true, "create-prefix"));
            check(!trial.inputFinished() && trial.draftLength() == 4);
            check(background ? trial.acceptBackground(source, "确认发送", true, "empty-create-confirm") : trial.accept(source, "确认发送", true, "empty-create-confirm"));
            check(!trial.inputFinished() && trial.beginReply(reply, "empty-create-never-network") == -1);
            check(background ? trial.acceptBackground(source, "推送调试", false, "create-partial") : trial.accept(source, "推送调试", false, "create-partial"));
            check(!trial.inputFinished());
            check(background ? trial.acceptBackground(source, "推送调试", true, "create-name") : trial.accept(source, "推送调试", true, "create-name"));
            check(!trial.inputFinished());
            check(background ? trial.acceptBackground(source, "确认发送", true, "create-confirm") : trial.accept(source, "确认发送", true, "create-confirm"));
            check(trial.inputFinished() && "新建对话，推送调试".equals(trial.question()));
          }
        }
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "新建对话", true, "restated-prefix"));
        check(trial.accept(source, "新增聊天 Push test", true, "restated-full"));
        check(!trial.inputFinished());
        check(trial.accept(source, "确认发送", true, "restated-confirm"));
        check("新建对话Push test".equals(trial.question()));
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "新建对话", true, "create-cancel-prefix"));
        check(trial.accept(source, "取消发送", true, "create-cancel"));
        check(trial.inputFinished() && trial.question().isEmpty());
        trial.stop(); trial.arm(true);
        check(trial.accept(source, "普通草稿", true, "creation-in-body"));
        check(trial.accept(source, "新增聊天推送调试", true, "creation-alias-in-body"));
        check(!trial.inputFinished());
        check(trial.accept(source, "确认发送", true, "body-confirm"));
        check("普通草稿，新增聊天推送调试".equals(trial.question()));
        check(VoiceCommand.isCreate("请帮我新建对话 Push test。"));
        check(VoiceCommand.isBarePending("新建对话："));
        check(!VoiceCommand.isControl("新建对话推送调试"));
        check(VoiceCommand.creationBlocked("新建对话测试", false));
        check(!VoiceCommand.creationBlocked("新建对话测试", true));
        check(!VoiceCommand.creationBlocked("请解释新建对话这个功能", false));
        System.out.println("native input trial checks passed");
    }
}
