package cn.yilu.rayneopaseo;

import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

public final class PinnedTlsTest {
    public static void main(String[] args) throws Exception {
        HttpsURLConnection http = null;
        try {
            http = PinnedTls.open(new java.net.URL(args[0]), args[1]);
            http.setConnectTimeout(3000); http.setReadTimeout(3000);
            http.setRequestProperty("Authorization", "Bearer " + args[2]);
            int status = http.getResponseCode();
            if (args[3].equals("reject")) throw new AssertionError("untrusted desktop received credentials");
            if (status != 200) throw new AssertionError("unexpected status " + status);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = http.getInputStream()) {
                byte[] chunk = new byte[1024]; int count;
                while ((count = input.read(chunk)) >= 0) bytes.write(chunk, 0, count);
            }
            System.out.println(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        } catch (java.io.IOException | java.security.GeneralSecurityException | IllegalArgumentException expected) {
            if (!args[3].equals("reject")) throw expected;
            System.out.println("identity rejected before HTTP");
        } finally { if (http != null) http.disconnect(); }
    }
}
