package cn.yilu.rayneopaseo;

import android.content.Context;
import android.util.Log;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** Disposable probe for the glasses' existing real-time prompt page. */
final class LensPromptProbe {
    private LensPromptProbe() {}

    static void send(Context context, int type, JSONObject message) {
        send(context, "PROACTIVE_AI", type, message);
    }

    static void send(Context context, String businessName, int type, JSONObject message) {
        sendChecked(context, businessName, type, message);
    }

    /** True means locally queued, never proof that the glasses rendered it. */
    static boolean sendChecked(Context context, String businessName, int type, JSONObject message) {
        try {
            ClassLoader loader = context.getClassLoader();
            Class<?> transport = loader.loadClass(HostBindings.TRANSPORT);
            Map<?, ?> devices = (Map<?, ?>) transport.getMethod(HostBindings.DEVICES_METHOD).invoke(null);
            if (devices.isEmpty()) throw new IllegalStateException("no connected device");
            Object device = devices.values().iterator().next();
            String deviceId = (String) device.getClass().getField("a").get(device);
            Class<?> envelope = loader.loadClass("com.rayneo.airuntime.tansport.proto.TransportMessage$CaptionMsg");
            Object builder = envelope.getMethod("newBuilder").invoke(null);
            builder.getClass().getMethod("setVersion", int.class).invoke(builder, 1);
            builder.getClass().getMethod("setType", int.class).invoke(builder, type);
            builder.getClass().getMethod("setMessage", String.class).invoke(builder, message.toString());
            Object built = builder.getClass().getMethod("build").invoke(builder);
            byte[] bytes = (byte[]) built.getClass().getMethod("toByteArray").invoke(built);
            @SuppressWarnings({"rawtypes", "unchecked"})
            Object business = Enum.valueOf((Class<? extends Enum>) loader.loadClass(HostBindings.BUSINESS), businessName);
            Class<?> request = loader.loadClass(HostBindings.REQUEST);
            Constructor<?> constructor = request.getConstructor(byte[].class, String.class, business.getClass(), String.class, String.class);
            Object packet = constructor.newInstance(bytes, deviceId, business, UUID.randomUUID().toString(), "");
            Class<?> callbackClass = loader.loadClass("kotlin.jvm.functions.Function2");
            InvocationHandler callback = (proxy, method, args) -> {
                if ("invoke".equals(method.getName())) Log.i("PaseoProbe", "display transport callback business=" + businessName + " type=" + type);
                return null;
            };
            Object listener = Proxy.newProxyInstance(loader, new Class<?>[]{callbackClass}, callback);
            Object sender = transport.getField("h").get(null);
            transport.getMethod(HostBindings.TRANSPORT_SEND_METHOD, request, callbackClass).invoke(sender, packet, listener);
            Log.i("PaseoProbe", "display transport sent business=" + businessName + " type=" + type + " chars=" + message.toString().length());
            return true;
        } catch (Exception failure) {
            Log.i("PaseoProbe", "display transport failed business=" + businessName + " type=" + type + " cause=" + failure.getClass().getSimpleName());
            return false;
        }
    }
}
