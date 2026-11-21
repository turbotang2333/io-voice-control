package cn.yilu.rayneopaseo;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MikaHttpTest {
    static final class Fake extends HttpURLConnection {
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        int status = 200;
        boolean failWrite;
        Fake(URL url) { super(url); }
        public void connect() {}
        public void disconnect() {}
        public boolean usingProxy() { return false; }
        public int getResponseCode() { return status; }
        public InputStream getInputStream() { return new ByteArrayInputStream("{\"ok\":true}".getBytes(StandardCharsets.UTF_8)); }
        public InputStream getErrorStream() { return new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)); }
        public OutputStream getOutputStream() throws java.io.IOException { if (failWrite) throw new java.io.IOException(); return body; }
    }
    private static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        Fake[] last = new Fake[1];
        MikaHttp c = new MikaHttp("https://mika.example.test", "secret", url -> last[0] = new Fake(url));
        MikaHttp.Result result = c.request("POST", "/tasks", "{\"goal\":\"测试\"}", 15000);
        check(result.status == 200 && result.body.contains("true"));
        check(last[0].getURL().toString().equals("https://mika.example.test/api/v1/tasks"));
        check("Bearer secret".equals(last[0].getRequestProperty("Authorization")));
        check(!last[0].getInstanceFollowRedirects());
        check(last[0].body.toString("UTF-8").contains("测试"));
        boolean rejected = false;
        try { new MikaHttp("http://mika.example.test", "secret", url -> new Fake(url)); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected);
        MikaHttp local = new MikaHttp("http://127.0.0.1:8765", "secret", url -> last[0] = new Fake(url));
        local.request("GET", "", null, 1000);
        check(last[0].getURL().toString().equals("http://127.0.0.1:8765/api/v1"));
        for (String address : new String[]{"http://localhost:8765", "http://127.0.0.2:8765", "http://127.0.0.1.evil.test:8765"}) {
            rejected = false;
            try { new MikaHttp(address, "secret", url -> new Fake(url)); } catch (IllegalArgumentException expected) { rejected = true; }
            check(rejected);
        }
        rejected = false;
        try { c.request("GET", "/tasks/../device", null, 1000); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected);
        Fake[] failing = new Fake[1];
        MikaHttp bad = new MikaHttp("https://mika.example.test", "secret", url -> { failing[0] = new Fake(url); failing[0].failWrite = true; return failing[0]; });
        boolean unknown = false;
        try { bad.request("POST", "/tasks", "{}", 1000); } catch (MikaHttp.Failure expected) { unknown = expected.outcomeUnknown; }
        check(unknown);
        System.out.println("Mika HTTP checks passed");
    }
}
