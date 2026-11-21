package cn.yilu.rayneopaseo;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
final class MikaHttp {
    interface Factory { HttpURLConnection open(URL url) throws Exception; }
    static final class Result {
        final int status; final String body;
        Result(int status, String body) { this.status = status; this.body = body; }
    }
    static final class Failure extends Exception {
        final boolean outcomeUnknown;
        Failure(boolean unknown) { super("Mika connection failed"); outcomeUnknown = unknown; }
    }
    private final String base, token;
    private final Factory factory;
    MikaHttp(String url, String token, Factory factory) {
        try {
            URI parsed = new URI(url == null ? "" : url.trim());
            boolean local = "http".equalsIgnoreCase(parsed.getScheme()) && "127.0.0.1".equals(parsed.getHost());
            if (!("https".equalsIgnoreCase(parsed.getScheme()) || local) || parsed.getHost() == null || parsed.getRawUserInfo() != null
                || parsed.getRawQuery() != null || parsed.getRawFragment() != null || parsed.getPort() == 0 || parsed.getPort() > 65535
                || !(parsed.getRawPath().isEmpty() || "/".equals(parsed.getRawPath()))) throw new IllegalArgumentException();
            if (token == null || token.trim().isEmpty() || token.contains("\r") || token.contains("\n") || factory == null) throw new IllegalArgumentException();
            base = parsed.toString().replaceFirst("/$", "") + "/api/v1"; this.token = token.trim(); this.factory = factory;
        } catch (Exception failure) { throw new IllegalArgumentException("Invalid Mika connection"); }
    }
    Result request(String method, String path, String body, int timeout) throws Exception {
        if (!("GET".equals(method) || "POST".equals(method)) || path == null || !path.matches("(?:|/tasks(?:/[0-9a-f-]{36}(?:/(?:wait|answer|steer|cancel))?)?)")
            || timeout < 1000 || timeout > 65000 || ("GET".equals(method) && body != null) || ("POST".equals(method) && body == null)) throw new IllegalArgumentException();
        HttpURLConnection connection = null; boolean sent = false; boolean mutation = "POST".equals(method) && !path.endsWith("/wait");
        try {
            connection = factory.open(new URL(base + path));
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(timeout);
            connection.setRequestMethod(method); connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Content-Type", "application/json");
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 65536) throw new IllegalArgumentException();
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                sent = true;
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (mutation && (status >= 500 || status >= 300 && status < 400)) throw new Failure(true);
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (result.size() + count > 262144) throw new java.io.IOException("response too large");
                    result.write(buffer, 0, count);
                }
            }
            return new Result(status, new String(result.toByteArray(), StandardCharsets.UTF_8));
        } catch (Failure failure) { throw failure; }
        catch (IllegalArgumentException failure) { throw failure; }
        catch (Exception failure) { throw new Failure(mutation && sent); }
        finally { if (connection != null) connection.disconnect(); }
    }
}
