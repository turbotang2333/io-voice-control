package cn.yilu.rayneopaseo;

import java.net.SocketTimeoutException;
import java.net.URL;

/** Only navigation challenge/bind metadata uses this policy. Never wrap a task submission. */
final class NavigationTransport {
    private static final int USB_ATTEMPTS = 1;
    private static final int USB_CONNECT_TIMEOUT_MS = 3000;
    private static final int USB_READ_TIMEOUT_MS = 5000;
    private static final int PUBLIC_ATTEMPTS = 2;
    private static final int PUBLIC_CONNECT_TIMEOUT_MS = 8000;
    private static final int PUBLIC_READ_TIMEOUT_MS = 15000;
    interface Guard { void check() throws Exception; }
    interface Request<T> { T run(int connectTimeoutMs, int readTimeoutMs, int attempt) throws Exception; }

    static <T> T exchange(URL endpoint, Guard current, Request<T> request) throws Exception {
        boolean usb = BridgeEndpoint.useLocalCertificate(endpoint);
        int attempts = usb ? USB_ATTEMPTS : PUBLIC_ATTEMPTS;
        for (int attempt = 1; attempt <= attempts; attempt++) {
            current.check();
            T result;
            try { result = request.run(usb ? USB_CONNECT_TIMEOUT_MS : PUBLIC_CONNECT_TIMEOUT_MS,
                usb ? USB_READ_TIMEOUT_MS : PUBLIC_READ_TIMEOUT_MS, attempt); }
            catch (SocketTimeoutException timeout) {
                if (attempt == attempts) throw timeout;
                continue;
            }
            current.check();
            return result;
        }
        throw new IllegalStateException("Navigation attempt limit reached");
    }
}
