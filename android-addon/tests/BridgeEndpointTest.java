package cn.yilu.rayneopaseo;

public final class BridgeEndpointTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        check(BridgeEndpoint.resolve("", 7467).toString().equals("https://127.0.0.1:7467/v1/chat/completions"));
        check(BridgeEndpoint.resolve(" https://example.com/rayneo-paseo/ ", 7467).toString().equals("https://example.com/rayneo-paseo/v1/chat/completions"));
        check(BridgeEndpoint.resolve("https://example.com", 7467).toString().equals("https://example.com/v1/chat/completions"));
        check(BridgeEndpoint.useLocalCertificate(BridgeEndpoint.resolve("", 7467)));
        check(!BridgeEndpoint.useLocalCertificate(BridgeEndpoint.resolve("https://example.com", 7467)));
        check(BridgeEndpoint.healthEndpoint("https://example.com/rayneo-paseo/", 7467).toString().equals("https://example.com/rayneo-paseo/healthz"));
        check(BridgeEndpoint.healthEndpoint("", 18468).toString().equals("https://127.0.0.1:18468/healthz"));
        for (String invalid : new String[]{"http://example.com", "https://user:pass@example.com", "https://example.com?a=b", "https://example.com#x", "https://example.com/../private", "https://example.com/%2e%2e", "https://example.com:99999", "https://", "https://example.com/v1/chat/completions"}) {
            boolean rejected = false;
            try { BridgeEndpoint.resolve(invalid, 7467); } catch (IllegalArgumentException expected) { rejected = true; }
            check(rejected);
        }
        check(BridgeEndpoint.failureMessage(401, "").contains("令牌"));
        check(BridgeEndpoint.failureMessage(409, "AGENT_NEEDS_PERMISSION").contains("授权"));
        check(BridgeEndpoint.failureMessage(409, "STATE_WRITE_FAILED").contains("保存"));
        check(BridgeEndpoint.failureMessage(503, "PASEO_OFFLINE").contains("未提交"));
        check(BridgeEndpoint.failureMessage(502, "").contains("不要重复发送"));
        check(BridgeEndpoint.connectionFailure(false).equals("（连接中断）本次未发送，请检查网络或电脑连接。"));
        check(BridgeEndpoint.connectionFailure(true).equals("（连接中断）请核对原会话，不要重复发送。"));
        check(BridgeEndpoint.healthMessage(200, "ready").equals("连接正常"));
        check(BridgeEndpoint.healthMessage(503, "reconnecting").contains("正在恢复"));
        check(BridgeEndpoint.healthMessage(401, "").contains("令牌"));
        check(!BridgeEndpoint.healthMessage(504, "").contains("正在恢复"));
        check(!BridgeEndpoint.healthMessage(200, "unexpected").equals("连接正常"));
        System.out.println("Bridge endpoint checks passed");
    }
}
