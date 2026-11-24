package com.hero.watchvoice.archive;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Collections;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import ohos.app.Context;
import ohos.net.NetCapabilities;
import ohos.net.NetHandle;
import ohos.net.NetManager;
import ohos.utils.zson.ZSONObject;

final class RecordingArchive {
    private static final Pattern NAME = Pattern.compile("watch-[0-9]{13}-[a-f0-9]{16}\\.m4a");
    private static final int MAX_AUDIO = 4 * 1024 * 1024;

    private RecordingArchive() {
    }

    static Summary sync(Context context, File directory, boolean retry) {
        File[] recordings = recordings(directory);
        int queued = pendingCount(recordings);
        if (queued == 0) return new Summary("", false, 0);
        if (RelaySettings.URL.isEmpty()) {
            return new Summary("待上传 " + queued + " · 未配置连接", false, 0);
        }
        NetHandle network = null;
        String bearer = "系统网络";
        try {
            NetManager manager = NetManager.getInstance(context);
            network = manager.getDefaultNet();
            if (network == null) {
                bearer = "手表无可用网络";
            } else {
                NetCapabilities caps = manager.getNetCapabilities(network);
                if (caps != null && caps.hasBearer(NetCapabilities.BEARER_BLUETOOTH)) bearer = "蓝牙";
                else if (caps != null && caps.hasBearer(NetCapabilities.BEARER_CELLULAR)) bearer = "移动数据";
                else if (caps != null && caps.hasBearer(NetCapabilities.BEARER_WIFI)) bearer = "Wi-Fi";
            }
        } catch (RuntimeException | LinkageError ignored) {
            // On older firmware the standard URL connection can still use the default network.
        }
        String problem = "";
        int stored = 0;
        int waiting = 0;
        int failed = 0;
        int silent = 0;
        int tested = 0;
        int pending = 0;
        for (File audio : recordings) {
            String status = readStatus(audio);
            if ("stored".equals(status)) continue;
            if (!retry && "test_received".equals(status)) {
                tested++;
                continue;
            }
            try {
                String result = submit(network, audio, retry);
                if (!"pending".equals(result)) writeStatus(audio, result);
                switch (result) {
                    case "stored": stored++; break;
                    case "processing": waiting++; break;
                    case "test_received": tested++; break;
                    case "no_speech_detected": silent++; break;
                    case "review": failed++; break;
                    default: pending++;
                }
            } catch (IOException | RuntimeException error) {
                pending++;
                if ("手表无可用网络".equals(bearer)) problem = bearer;
                else if (error instanceof UnknownHostException) problem = "DNS 无法解析";
                else if (error instanceof SSLException) problem = "HTTPS 校验失败";
                else if (network == null) problem = bearer;
                else problem = bearer + "连接失败";
                break;
            }
        }
        int remaining = pendingCount(recordings);
        boolean canRetry = remaining > 0;
        if (waiting > 0) return new Summary("服务器正在转写", canRetry, 5000);
        if (failed > 0) return new Summary("转写待检查 " + failed, canRetry, 0);
        if (silent > 0) return new Summary("未识别到讲话 · 录音保留", canRetry, 0);
        if (tested > 0) return new Summary("测试已接收 · " + bearer, canRetry, 0);
        if (pending > 0) {
            String status = problem.isEmpty() ? "待上传 " + remaining : "待上传 · " + problem;
            return new Summary(status, canRetry, 15000);
        }
        return new Summary(stored > 0 ? "文字已保存" : "", canRetry, 0);
    }

    static File[] recordings(File directory) {
        File[] files = directory.listFiles((parent, name) -> NAME.matcher(name).matches());
        if (files == null) return new File[0];
        Arrays.sort(files, Collections.reverseOrder());
        return files;
    }

    static boolean delete(File audio) {
        if (!audio.delete() && audio.exists()) return false;
        statusFile(audio).delete();
        return true;
    }

    static String statusLabel(File audio) {
        switch (readStatus(audio)) {
            case "stored": return "已上传";
            case "processing": return "转写中";
            case "test_received": return "测试已接收";
            case "no_speech_detected": return "无有效语音";
            case "review": return "待检查";
            default: return "待上传";
        }
    }

    private static int pendingCount(File[] recordings) {
        int pending = 0;
        for (File audio : recordings) if (!"stored".equals(readStatus(audio))) pending++;
        return pending;
    }

    private static File statusFile(File audio) {
        return new File(audio.getParentFile(), audio.getName() + ".status");
    }

    private static String readStatus(File audio) {
        File file = statusFile(audio);
        if (!file.isFile() || file.length() > 64) return "pending";
        try {
            return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        } catch (IOException error) {
            return "pending";
        }
    }

    private static void writeStatus(File audio, String status) throws IOException {
        File target = statusFile(audio);
        File temporary = new File(target.getParentFile(), target.getName() + ".part");
        Files.write(temporary.toPath(), status.getBytes(StandardCharsets.UTF_8));
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    private static String submit(NetHandle network, File audio, boolean retry) throws IOException {
        String name = audio.getName();
        String id = name.substring("watch-".length(), name.length() - ".m4a".length());
        URL url = new URL(RelaySettings.URL + "/v1/recordings/" + id);
        Receipt reply = request(network, url, null, false);
        boolean retryable = reply.status == 409 && ("transcription_failed".equals(reply.value("error"))
                || "transcript_missing".equals(reply.value("error")));
        if (reply.status == 404 || (retry && retryable)) {
            if (audio.length() < 16 || audio.length() > MAX_AUDIO) return "review";
            reply = request(network, url, audio, reply.status == 409);
        }
        if (reply.status == 409 && "no_speech_detected".equals(reply.value("error"))) return "no_speech_detected";
        if (reply.status == 409 || reply.status == 422 || reply.status == 413) return "review";
        if (!id.equals(reply.value("id"))) return "pending";
        String state = reply.value("status");
        if (reply.status == 200 && "stored".equals(state)
                && ("watch-" + id + ".txt").equals(reply.value("file"))) return "stored";
        if (reply.status == 202 && ("processing".equals(state) || "test_received".equals(state))) return state;
        return "pending";
    }

    private static Receipt request(NetHandle network, URL url, File audio, boolean retry) throws IOException {
        try {
            return requestWithSystemDns(network, url, audio, retry);
        } catch (UnknownHostException | SSLException error) {
            RelayTransport.Reply reply = RelayTransport.request(network, url, audio, retry);
            return new Receipt(reply.status, ZSONObject.stringToZSON(reply.body));
        }
    }

    private static Receipt requestWithSystemDns(NetHandle network, URL url, File audio, boolean retry) throws IOException {
        HttpsURLConnection connection = (HttpsURLConnection) (network == null ? url.openConnection() : network.openConnection(url));
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(35000);
        connection.setRequestProperty("Authorization", "Bearer " + RelaySettings.TOKEN);
        try {
            if (audio != null) {
                connection.setRequestMethod("PUT");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "audio/mp4");
                if (retry) connection.setRequestProperty("X-Archive-Retry", "1");
                connection.setFixedLengthStreamingMode(audio.length());
                try (InputStream input = new FileInputStream(audio); OutputStream output = connection.getOutputStream()) {
                    byte[] buffer = new byte[32768];
                    for (int read; (read = input.read(buffer)) != -1;) output.write(buffer, 0, read);
                }
            }
            int status = connection.getResponseCode();
            try (InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream()) {
                if (input == null) return new Receipt(status, null);
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[512];
                for (int read; (read = input.read(buffer)) != -1;) {
                    if (body.size() + read > 8192) throw new IOException("Response too large");
                    body.write(buffer, 0, read);
                }
                return new Receipt(status, ZSONObject.stringToZSON(new String(body.toByteArray(), StandardCharsets.UTF_8)));
            }
        } finally {
            connection.disconnect();
        }
    }

    private static final class Receipt {
        final int status;
        final ZSONObject body;

        Receipt(int status, ZSONObject body) {
            this.status = status;
            this.body = body;
        }

        String value(String field) {
            return body == null ? "" : body.getString(field);
        }
    }

    static final class Summary {
        final String message;
        final boolean canRetry;
        final int retryAfterMs;

        Summary(String message, boolean canRetry, int retryAfterMs) {
            this.message = message;
            this.canRetry = canRetry;
            this.retryAfterMs = retryAfterMs;
        }
    }
}
