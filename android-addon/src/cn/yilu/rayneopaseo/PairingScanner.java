package cn.yilu.rayneopaseo;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.content.pm.PackageManager;
import android.content.Context;
import android.hardware.Camera;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Local camera frames only. Decoded QR data is never logged or uploaded as an image. */
@SuppressWarnings("deprecation")
final class PairingScanner {
    private final Activity activity;
    private final Consumer<String> scanned;
    private final Dialog dialog;
    private final SurfaceView preview;
    private final TextView status;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding = new AtomicBoolean();
    private final Handler main = new Handler(Looper.getMainLooper());
    private Camera camera;
    private boolean surfaceReady, closed;
    private long lastFrame;
    private PairingScanner(Activity activity, Consumer<String> scanned) {
        this.activity = activity; this.scanned = scanned;
        Context context = AssistantSettingsUi.dialogContext(activity);
        dialog = new Dialog(context); dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout layout = new LinearLayout(context); layout.setOrientation(LinearLayout.VERTICAL);
        int padding = AssistantSettingsUi.dp(activity, 20); layout.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(context); title.setText("扫描电脑配对码"); title.setTextSize(22); layout.addView(title);
        status = new TextView(context); status.setText("对准连接器中的二维码，识别后会请你确认电脑和连接模式。"); status.setTextSize(15);
        status.setPadding(0, padding, 0, padding); layout.addView(status);
        preview = new SurfaceView(context);
        layout.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));
        Button start = new Button(context); start.setText("允许相机并开始扫描");
        start.setOnClickListener(view -> {
            if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, 6931);
                status.setText("允许相机后，再点一次开始扫描。相机画面只用于识别二维码。");
            } else startCamera();
        }); layout.addView(start, new LinearLayout.LayoutParams(-1, -2));
        Button cancel = new Button(context); cancel.setText("取消"); cancel.setOnClickListener(view -> dialog.dismiss()); layout.addView(cancel);
        dialog.setContentView(layout);
        preview.getHolder().addCallback(new SurfaceHolder.Callback() {
            public void surfaceCreated(SurfaceHolder holder) { surfaceReady = true; startCamera(); }
            public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
            public void surfaceDestroyed(SurfaceHolder holder) { surfaceReady = false; releaseCamera(); }
        });
        dialog.setOnDismissListener(ignored -> { closed = true; releaseCamera(); decoder.shutdownNow(); });
    }
    static void show(Activity activity, Consumer<String> scanned) {
        PairingScanner scanner = new PairingScanner(activity, scanned); scanner.dialog.show();
        if (scanner.dialog.getWindow() != null) scanner.dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }
    private void startCamera() {
        if (closed || !surfaceReady || camera != null) return;
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            int selected = -1;
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
                Camera.CameraInfo info = new Camera.CameraInfo(); Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { selected = i; break; }
            }
            if (selected < 0) throw new IllegalStateException();
            camera = Camera.open(selected); Camera.Parameters parameters = camera.getParameters();
            Camera.Size size = null;
            for (Camera.Size candidate : parameters.getSupportedPreviewSizes()) {
                if (candidate.width >= 640 && candidate.width <= 1280 && candidate.height >= 480 && candidate.height <= 960
                    && (size == null || candidate.width * candidate.height < size.width * size.height)) size = candidate;
            }
            if (size != null) parameters.setPreviewSize(size.width, size.height);
            if (parameters.getSupportedFocusModes() != null && parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE))
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(parameters);
            Camera.CameraInfo info = new Camera.CameraInfo(); Camera.getCameraInfo(selected, info);
            int rotation = activity.getWindowManager().getDefaultDisplay().getRotation() * 90;
            camera.setDisplayOrientation((info.orientation - rotation + 360) % 360);
            camera.setPreviewDisplay(preview.getHolder()); camera.setPreviewCallback((bytes, source) -> decode(bytes, source)); camera.startPreview();
            status.setText("请把电脑上的二维码完整放入画面。");
        } catch (Exception unavailable) { releaseCamera(); status.setText("暂时无法使用相机，请关闭占用相机的应用后重试。"); }
    }
    private void decode(byte[] bytes, Camera source) {
        long now = SystemClock.elapsedRealtime();
        if (closed || now - lastFrame < 250 || !decoding.compareAndSet(false, true)) return;
        lastFrame = now;
        try {
            Camera.Size size = source.getParameters().getPreviewSize();
            final int width = size.width, height = size.height;
            if (bytes == null || bytes.length < width * height) { decoding.set(false); return; }
            final byte[] luminance = java.util.Arrays.copyOf(bytes, width * height);
            decoder.execute(() -> {
                MultiFormatReader reader = new MultiFormatReader();
                try {
                    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
                    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
                    hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
                    String value = reader.decode(new BinaryBitmap(new HybridBinarizer(new PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false))), hints).getText();
                    try { PairingCode.parse(value); }
                    catch (IllegalArgumentException invalid) { main.post(() -> { if (!closed) status.setText("这不是眼镜助手配对码，请扫描电脑连接器中的二维码。"); }); return; }
                    main.post(() -> { if (!closed) { dialog.dismiss(); scanned.accept(value); } });
                } catch (Exception notFound) { /* Keep scanning without persisting camera data. */ }
                finally { reader.reset(); decoding.set(false); }
            });
        } catch (Exception unavailable) { decoding.set(false); }
    }
    private void releaseCamera() {
        if (camera == null) return;
        try { camera.setPreviewCallback(null); camera.stopPreview(); } catch (Exception ignored) {}
        try { camera.release(); } catch (Exception ignored) {} camera = null;
    }
}
