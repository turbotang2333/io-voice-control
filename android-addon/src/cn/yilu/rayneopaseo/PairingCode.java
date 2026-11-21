package cn.yilu.rayneopaseo;

import java.net.URI;
import java.net.URL;

/** Only a short-lived pairing proof is present in a QR code. Never a permanent access token. */
final class PairingCode {
    final URL claimUrl;
    final String code, certificateSha256;
    private PairingCode(URL claimUrl, String code, String certificateSha256) {
        this.claimUrl = claimUrl; this.code = code; this.certificateSha256 = certificateSha256;
    }
    static PairingCode parse(String value) {
        try {
            if (value == null || value.length() > 2048) throw new IllegalArgumentException();
            URI uri = new URI(value);
            String path = uri.getRawPath(), fragment = uri.getRawFragment();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                || "localhost".equalsIgnoreCase(uri.getHost()) || "127.0.0.1".equals(uri.getHost()) || "[::1]".equals(uri.getHost())
                || uri.getPort() == 0 || uri.getPort() > 65535 || path == null || !path.matches("[A-Za-z0-9/_-]*/pair") || path.contains("//")
                || fragment == null || !fragment.matches("rayneo_pair=[A-Za-z0-9_-]{43}(&tls_sha256=[a-f0-9]{64})?")) throw new IllegalArgumentException();
            URL claim = new URI("https", null, uri.getHost(), uri.getPort(), path.substring(0, path.length() - 5) + "/v1/pairing/claim", null, null).toURL();
            String[] fields = fragment.split("&", -1);
            return new PairingCode(claim, fields[0].substring("rayneo_pair=".length()), fields.length == 2 ? fields[1].substring("tls_sha256=".length()) : "");
        } catch (Exception invalid) { throw new IllegalArgumentException("这不是有效的眼镜助手配对码，请重新扫描电脑上的二维码"); }
    }
}
