package cn.yilu.rayneopaseo;

import java.net.URL;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Trust only the desktop certificate scanned on the computer. Keep standard hostname verification. */
final class PinnedTls {
    private PinnedTls() {}
    static HttpsURLConnection open(URL url, String fingerprint) throws java.io.IOException, GeneralSecurityException {
        if (!"https".equals(url.getProtocol()) || fingerprint == null || (!fingerprint.isEmpty() && !fingerprint.matches("[a-f0-9]{64}")))
            throw new IllegalArgumentException("电脑身份信息无效，请重新扫码配对");
        HttpsURLConnection http = (HttpsURLConnection)url.openConnection();
        http.setInstanceFollowRedirects(false);
        if (!fingerprint.isEmpty()) {
            final byte[] expected = new byte[32];
            for (int i = 0; i < expected.length; i++) expected[i] = (byte)Integer.parseInt(fingerprint.substring(i * 2, i * 2 + 2), 16);
            X509TrustManager pinned = new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    throw new CertificateException("Client authentication is not supported");
                }
                public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("Desktop certificate missing");
                    chain[0].checkValidity();
                    try {
                        byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                        if (!MessageDigest.isEqual(expected, actual)) throw new CertificateException("Desktop identity changed");
                    } catch (GeneralSecurityException invalid) { throw new CertificateException("Desktop identity verification failed", invalid); }
                }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{pinned}, null);
            http.setSSLSocketFactory(context.getSocketFactory());
        }
        return http;
    }
}
