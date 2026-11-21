package cn.yilu.rayneopaseo;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** A fixed loopback connection; never uses the phone's proxy or external interfaces. */
final class MikaLocalHttp {
    private final int port;
    private final String token;
    MikaLocalHttp(int port, String token) {
        if (port < 1024 || port > 65535 || token == null || !token.matches("[A-Za-z0-9_-]{1,256}")) throw new IllegalArgumentException();
        this.port = port; this.token = token;
    }
    MikaHttp.Result request(String method, String path, String body, int timeout) throws MikaHttp.Failure {
        if (!("GET".equals(method) || "POST".equals(method)) || path == null
            || !path.matches("(?:|/tasks(?:/[0-9a-f-]{36}(?:/(?:wait|answer|steer|cancel|export))?)?)")
            || timeout < 1000 || timeout > 65000 || ("GET".equals(method) && body != null)
            || ("POST".equals(method) && body == null)) throw new IllegalArgumentException();
        return exchange(method, "/api/v1" + path, body, timeout, path.endsWith("/export") ? 8388608 : 262144, !("POST".equals(method) && path.endsWith("/wait")));
    }
    MikaHttp.Result deviceCall(String body) throws MikaHttp.Failure {
        if (body == null) throw new IllegalArgumentException();
        return exchange("POST", "/mcp", body, 30000, 262144, true);
    }
    private MikaHttp.Result exchange(String method, String path, String body, int timeout, int maxLength, boolean mayMutate) throws MikaHttp.Failure {
        byte[] payload = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        if (payload.length > 65536) throw new IllegalArgumentException();
        boolean mutation = "POST".equals(method) && mayMutate, sent = false;
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getByAddress(new byte[]{127, 0, 0, 1}), port), 8000);
            socket.setSoTimeout(timeout);
            OutputStream out = socket.getOutputStream();
            String headers = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + port
                + "\r\nAuthorization: Bearer " + token + "\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + payload.length + "\r\n\r\n";
            sent = true;
            out.write(headers.getBytes(StandardCharsets.US_ASCII)); out.write(payload); out.flush();
            InputStream in = socket.getInputStream();
            String statusLine = line(in); String[] parts = statusLine.split(" ", 3);
            if (parts.length < 2 || !parts[0].startsWith("HTTP/1.")) throw new java.io.IOException();
            int status = Integer.parseInt(parts[1]); int length = -1; int headerCount = 0;
            for (;;) {
                String header = line(in); if (header.isEmpty()) break;
                if (++headerCount > 100) throw new java.io.IOException();
                int colon = header.indexOf(':'); if (colon < 1) throw new java.io.IOException();
                String name = header.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                if ("content-length".equals(name)) { if (length >= 0) throw new java.io.IOException(); length = Integer.parseInt(header.substring(colon + 1).trim()); }
                if ("transfer-encoding".equals(name)) throw new java.io.IOException();
            }
            if (length < 0 || length > maxLength) throw new java.io.IOException();
            byte[] bytes = new byte[length]; int pos = 0;
            while (pos < length) { int count = in.read(bytes, pos, length - pos); if (count < 0) throw new java.io.IOException(); pos += count; }
            if (mutation && (status >= 500 || status >= 300 && status < 400)) throw new MikaHttp.Failure(true);
            return new MikaHttp.Result(status, new String(bytes, StandardCharsets.UTF_8));
        } catch (MikaHttp.Failure e) { throw e; }
        catch (Exception e) { throw new MikaHttp.Failure(mutation && sent); }
    }
    private static String line(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (out.size() < 8192) {
            int value = in.read(); if (value < 0) throw new java.io.IOException();
            if (value == '\r') { if (in.read() != '\n') throw new java.io.IOException(); return out.toString("US-ASCII"); }
            if (value == '\n') throw new java.io.IOException(); out.write(value);
        }
        throw new java.io.IOException();
    }
}
