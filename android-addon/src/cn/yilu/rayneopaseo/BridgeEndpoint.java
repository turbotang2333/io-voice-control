package cn.yilu.rayneopaseo;

import java.net.URI;
import java.net.URL;

/** Connection configuration only; never relax certificate or hostname verification. */
public final class BridgeEndpoint {
    private BridgeEndpoint() {}
    public static URL resolve(String base, int usbPort) {
        try {
            if (usbPort < 1024 || usbPort > 65535) throw new IllegalArgumentException();
            String value = base == null ? "" : base.trim();
            if (value.isEmpty()) value = "https://127.0.0.1:" + usbPort;
            URI uri = new URI(value);
            String path = uri.getRawPath();
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || uri.getPort() == 0 || uri.getPort() > 65535
                || (path != null && (!path.matches("[A-Za-z0-9/_-]*") || path.contains("//") || path.endsWith("/v1/chat/completions")))) {
                throw new IllegalArgumentException();
            }
            while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
            return new URL(value + "/v1/chat/completions");
        } catch (Exception error) { throw new IllegalArgumentException("Invalid HTTPS base address"); }
    }
    public static boolean useLocalCertificate(URL url) {
        return "127.0.0.1".equals(url.getHost()) || "localhost".equalsIgnoreCase(url.getHost());
    }
    public static URL healthEndpoint(String base, int usbPort) {
        try { return new URL(resolve(base, usbPort).toString().replaceFirst("/v1/chat/completions$", "/healthz")); }
        catch (Exception failure) { throw new IllegalArgumentException("Invalid HTTPS base address"); }
    }
    public static String connectionFailure(boolean mayHaveBeenSent) {
        return mayHaveBeenSent ? "（连接中断）请核对原会话，不要重复发送。"
            : "（连接中断）本次未发送，请检查网络或电脑连接。";
    }
    public static String healthMessage(int status, String state) {
        if (status == 200 && "ready".equals(state)) return "连接正常";
        if (status == 503 && "reconnecting".equals(state)) return "电脑正在恢复 Paseo 连接，请稍后再检查";
        if (status == 401 || status == 403) return "访问令牌未通过，请检查手机连接设置";
        if (status == 404) return "接入地址不匹配，请检查手机连接设置";
        return "连接不可用，请检查手机网络和电脑连接";
    }
    public static String failureMessage(int status, String code) {
        if (status == 401 || status == 403) return "访问令牌未通过，请在手机设置中检查；本次未提交。";
        if ("PASEO_OFFLINE".equals(code)) return "电脑正在恢复 Paseo 连接，本次未提交；请稍后核对原会话再发送。";
        if ("AGENT_NEEDS_PERMISSION".equals(code)) return "Paseo 正等待授权，请在手机或电脑上处理。";
        if ("AGENT_BUSY".equals(code)) return "Agent 正在执行，请等待完成并查看原会话。";
        if ("STATE_WRITE_FAILED".equals(code)) return "电脑未能保存选择或请求记录，本次未提交；请检查电脑存储。";
        if ("WRONG_WORKSPACE".equals(code) || "AGENT_NOT_FOUND".equals(code)) return "项目或 Agent 已变化，请重新列出并选择。";
        if (status == 404) return "接入地址不匹配，请检查手机中的 HTTPS 地址；不要重复发送。";
        return connectionFailure(true);
    }
}
