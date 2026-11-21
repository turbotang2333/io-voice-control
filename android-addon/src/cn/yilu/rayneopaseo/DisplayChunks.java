package cn.yilu.rayneopaseo;

/** The glasses append answer chunks, so send each part of an Agent reply only once. */
public final class DisplayChunks {
    private String delivered = "";
    public String preview(String snapshot) {
        if (snapshot == null || !snapshot.startsWith(delivered) || snapshot.length() == delivered.length()) return null;
        return snapshot.substring(delivered.length());
    }
    public void previewDelivered(String snapshot) { delivered = snapshot; }
    public String finalChunk(String fullAnswer) {
        if (fullAnswer == null) return "";
        return fullAnswer.startsWith(delivered) ? fullAnswer.substring(delivered.length()) : fullAnswer;
    }
}
