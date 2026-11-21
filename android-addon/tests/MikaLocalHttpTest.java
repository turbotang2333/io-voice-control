package cn.yilu.rayneopaseo;
import java.net.ServerSocket;
import java.net.Socket;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class MikaLocalHttpTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            Thread peer = new Thread(() -> {
                try (Socket socket = server.accept()) {
                    InputStream in = socket.getInputStream();
                    java.io.ByteArrayOutputStream data = new java.io.ByteArrayOutputStream();
                    int c; while ((c = in.read()) >= 0) { data.write(c); if (data.toString("UTF-8").endsWith("\r\n\r\n")) break; }
                    String request = data.toString("UTF-8");
                    if (!request.startsWith("GET /api/v1 HTTP/1.1\r\n") || !request.contains("Authorization: Bearer example\r\n")) throw new AssertionError();
                    OutputStream out = socket.getOutputStream(); out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".getBytes(StandardCharsets.UTF_8)); out.flush();
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            peer.start();
            MikaHttp.Result result = new MikaLocalHttp(server.getLocalPort(), "example").request("GET", "", null, 3000);
            check(result.status == 200 && "{}".equals(result.body)); peer.join();
        }
        try { new MikaLocalHttp(8765, "bad\r\nvalue"); throw new AssertionError(); } catch (IllegalArgumentException expected) { }
        System.out.println("Mika local HTTP checks passed");
    }
}
