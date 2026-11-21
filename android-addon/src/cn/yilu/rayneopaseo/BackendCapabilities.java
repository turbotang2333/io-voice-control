package cn.yilu.rayneopaseo;

/** A feature is usable only on the current backend and when explicitly advertised. */
final class BackendCapabilities {
    private BackendCapabilities() {}
    static boolean accepts(String backend, String bindingBackend, boolean supported) {
        return supported && ("paseo".equals(backend) || "codex".equals(backend)) && backend.equals(bindingBackend);
    }
}
