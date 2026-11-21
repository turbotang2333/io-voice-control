package cn.yilu.rayneopaseo;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import javax.net.ssl.SSLHandshakeException;

public final class NavigationTransportTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        URL publicEndpoint = new URL("https://example.invalid/v1/navigation/session");
        URL usbEndpoint = new URL("https://127.0.0.1:19469/v1/navigation/session");
        int[] calls = {0};
        String binding = NavigationTransport.exchange(publicEndpoint, () -> {}, (connect, read, attempt) -> {
            if (++calls[0] == 1) throw new SocketTimeoutException("synthetic");
            return "same-binding";
        });
        check(binding.equals("same-binding") && calls[0] == 2);
        calls[0] = 0;
        try {
            NavigationTransport.exchange(publicEndpoint, () -> {}, (connect, read, attempt) -> {
                calls[0]++; throw new SocketTimeoutException("synthetic");
            }); throw new AssertionError();
        } catch (SocketTimeoutException expected) { check(calls[0] == 2); }
        calls[0] = 0;
        try {
            NavigationTransport.exchange(usbEndpoint, () -> {}, (connect, read, attempt) -> {
                calls[0]++; throw new SocketTimeoutException("synthetic");
            }); throw new AssertionError();
        } catch (SocketTimeoutException expected) { check(calls[0] == 1); }
        for (Exception failure : new Exception[]{new SSLHandshakeException("synthetic"),
                new IOException("invalid response"), new IllegalStateException("not authorized")}) {
            calls[0] = 0;
            try {
                NavigationTransport.exchange(publicEndpoint, () -> {}, (connect, read, attempt) -> {
                    calls[0]++; throw failure;
                }); throw new AssertionError();
            } catch (Exception expected) { check(expected == failure && calls[0] == 1); }
        }
        calls[0] = 0;
        boolean[] current = {true};
        try {
            NavigationTransport.exchange(publicEndpoint, () -> {
                if (!current[0]) throw new IllegalStateException("cancelled or changed navigation");
            }, (connect, read, attempt) -> {
                calls[0]++; current[0] = false; throw new SocketTimeoutException("synthetic");
            }); throw new AssertionError();
        } catch (IllegalStateException expected) { check(calls[0] == 1); }

        // A real socket fixture reproduces a response slower than the old five-second limit.
        // This local HTTP fixture does not change production HTTPS validation.
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/slow", exchange -> {
            try {
                Thread.sleep(6200);
                byte[] bytes = "binding".getBytes("UTF-8");
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            finally { exchange.close(); }
        });
        server.start();
        try {
            URL fixture = new URL("http://127.0.0.1:" + server.getAddress().getPort() + "/slow");
            calls[0] = 0;
            int status = NavigationTransport.exchange(publicEndpoint, () -> {}, (connect, read, attempt) -> {
                calls[0]++;
                HttpURLConnection http = (HttpURLConnection)fixture.openConnection();
                try { http.setConnectTimeout(connect); http.setReadTimeout(read); return http.getResponseCode(); }
                finally { http.disconnect(); }
            });
            check(status == 200 && calls[0] == 1);
        } finally { server.stop(0); }
        System.out.println("Navigation transport checks passed");
    }
}
