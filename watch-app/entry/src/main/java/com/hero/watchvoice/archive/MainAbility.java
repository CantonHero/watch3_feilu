package com.hero.watchvoice.archive;

import static ohos.agp.components.ComponentContainer.LayoutConfig.MATCH_CONTENT;
import static ohos.agp.components.ComponentContainer.LayoutConfig.MATCH_PARENT;
import static ohos.agp.window.service.WindowManager.LayoutConfig.MARK_SCREEN_ON_ALWAYS;

import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import ohos.aafwk.ability.Ability;
import ohos.aafwk.content.Intent;
import ohos.agp.colors.RgbColor;
import ohos.agp.components.Button;
import ohos.agp.components.DirectionalLayout;
import ohos.agp.components.StackLayout;
import ohos.agp.components.Text;
import ohos.agp.components.element.ShapeElement;
import ohos.agp.utils.Color;
import ohos.agp.utils.LayoutAlignment;
import ohos.agp.utils.TextAlignment;
import ohos.agp.window.service.DisplayManager;
import ohos.app.dispatcher.task.Revocable;
import ohos.bundle.IBundleManager;
import ohos.hiviewdfx.HiLog;
import ohos.hiviewdfx.HiLogLabel;
import ohos.media.common.AudioProperty;
import ohos.media.common.Source;
import ohos.media.common.StorageProperty;
import ohos.media.recorder.Recorder;

public class MainAbility extends Ability {
    private static final int MAX_SECONDS = 300;
    private static final int VERTICAL_LAYOUT = 1;
    private static final int MIC_REQUEST = 1;
    private static final String MICROPHONE = "ohos.permission.MICROPHONE";
    private static final HiLogLabel LOG = new HiLogLabel(HiLog.LOG_APP, 0x0001, "WatchVoice");
    static final int PALE = 0xffbec9d0;
    static final int MINT = 0xffa9dfd1;
    static final int RED = 0xfff36e6e;

    static final ExecutorService ARCHIVE_WORKER = Executors.newSingleThreadExecutor();
    private DirectionalLayout home;
    private RecordingLibrary library;
    private Text title;
    private Text elapsed;
    private Text status;
    private Text delivery;
    private Button start;
    private Button pause;
    private Button libraryButton;
    private StackLayout recordingActions;
    private Button retry;
    private File directory;
    private File capture;
    private Recorder recorder;
    private Revocable clock;
    private Revocable poll;
    private long started;
    private long recordedNanos;
    private boolean paused;
    private boolean visible;
    private boolean startAfterPermission;
    private boolean askingPermission;
    private boolean syncing;
    private boolean syncAgain;
    private boolean destroyed;
    private float scale;

    @Override
    protected void onStart(Intent intent) {
        super.onStart(intent);
        directory = new File(getFilesDir(), "recordings");
        scale = DisplayManager.getInstance().getDefaultDisplay(this)
                .map(display -> display.getAttributes().width / 466f).orElse(1f);
        home = new DirectionalLayout(this);
        home.setOrientation(VERTICAL_LAYOUT);
        home.setAlignment(LayoutAlignment.CENTER);
        home.setLayoutConfig(new DirectionalLayout.LayoutConfig(MATCH_PARENT, MATCH_PARENT));
        home.setBackground(background(0xff111519, 0));

        title = text("飞录", 25, PALE);
        elapsed = text("00:00", 66, 0xfff5f7f8);
        start = button("开始录音", 226, 68, MINT);
        start.setClickedListener(component -> startRecording());
        pause = button("暂停", 160, 74, MINT);
        pause.setClickedListener(component -> togglePause());
        Button stop = button("停止", 160, 74, RED);
        stop.setClickedListener(component -> stopRecording());
        recordingActions = actionRow(pause, stop, 338, 160, 74);
        recordingActions.setVisibility(Button.HIDE);
        status = text("", 20, PALE);
        delivery = text("", 19, PALE);
        retry = button("重试", 146, 40, 0xffbec9d0);
        retry.setClickedListener(component -> syncPending(true));
        retry.setVisibility(Button.HIDE);
        libraryButton = button("录音列表", 167, 47, PALE);
        libraryButton.setClickedListener(component -> showLibrary());
        home.addComponent(title);
        home.addComponent(elapsed);
        home.addComponent(start);
        home.addComponent(recordingActions);
        home.addComponent(status);
        home.addComponent(delivery);
        home.addComponent(retry);
        home.addComponent(libraryButton);
        setUIContent(home);
    }

    @Override
    protected void onActive() {
        super.onActive();
        visible = true;
        if (startAfterPermission) {
            startAfterPermission = false;
            startRecording();
        }
        syncPending(false);
    }

    @Override
    protected void onBackground() {
        visible = false;
        if (poll != null) poll.revoke();
        if (recorder != null) stopRecording();
        if (library != null) library.stopPlayback();
        super.onBackground();
    }

    @Override
    protected void onStop() {
        visible = false;
        destroyed = true;
        if (recorder != null) stopRecording();
        if (poll != null) poll.revoke();
        if (library != null) library.close();
        super.onStop();
    }

    @Override
    protected void onBackPressed() {
        if (library == null) super.onBackPressed();
        else if (!library.cancelConfirmation()) showHome();
    }

    private void showLibrary() {
        if (recorder != null || library != null) return;
        library = new RecordingLibrary(this, directory, this::showHome, () -> syncPending(false));
        setUIContent(library.view());
    }

    private void showHome() {
        if (library == null) return;
        library.close();
        library = null;
        setUIContent(home);
        syncPending(false);
    }

    @Override
    public void onRequestPermissionsFromUserResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsFromUserResult(requestCode, permissions, results);
        if (requestCode != MIC_REQUEST) return;
        askingPermission = false;
        if (results.length > 0 && results[0] == IBundleManager.PERMISSION_GRANTED) {
            if (visible) startRecording();
            else startAfterPermission = true;
        } else {
            status.setText("请在设置中允许麦克风");
        }
    }

    private void startRecording() {
        if (!visible || recorder != null || askingPermission) return;
        if (verifySelfPermission(MICROPHONE) != IBundleManager.PERMISSION_GRANTED) {
            askingPermission = true;
            requestPermissionsFromUser(new String[] { MICROPHONE }, MIC_REQUEST);
            return;
        }
        elapsed.setText("00:00");
        status.setText("");
        String step = "创建文件";
        Recorder candidate = null;
        try {
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("recordings dir");
            String id = System.currentTimeMillis() + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            capture = new File(directory, "watch-" + id + ".m4a.part");
            step = "打开麦克风";
            candidate = new Recorder();
            Source source = new Source();
            source.setRecorderAudioSource(Recorder.AudioSource.MIC);
            if (!candidate.setSource(source)) throw new IOException("setSource");
            step = "配置音频";
            AudioProperty audio = new AudioProperty.Builder()
                    .setRecorderAudioEncoder(Recorder.AudioEncoder.AAC)
                    .setRecorderNumChannels(1).setRecorderSamplingRate(44100).setRecorderBitRate(48000).build();
            StorageProperty storage = new StorageProperty.Builder().setRecorderFile(capture).build();
            if (!candidate.setOutputFormat(Recorder.OutputFormat.MPEG_4)
                    || !candidate.setAudioProperty(audio) || !candidate.setStorageProperty(storage)) {
                throw new IOException("configure");
            }
            step = "准备录音";
            if (!candidate.prepare()) throw new IOException("prepare");
            step = "开始录音";
            if (!candidate.start()) throw new IOException("start");
        } catch (IOException | RuntimeException | LinkageError error) {
            if (candidate != null) candidate.release();
            HiLog.error(LOG, "Recorder start failed: %{public}s %{public}s", step, error.getClass().getSimpleName());
            status.setText(step + "失败");
            return;
        }
        recorder = candidate;
        recordedNanos = 0;
        paused = false;
        started = System.nanoTime();
        getWindow().addWindowFlags(MARK_SCREEN_ON_ALWAYS);
        title.setText("录音中");
        pause.setText("暂停");
        start.setVisibility(Button.HIDE);
        libraryButton.setVisibility(Button.HIDE);
        recordingActions.setVisibility(Button.VISIBLE);
        tick();
    }

    private void togglePause() {
        if (recorder == null) return;
        long now = System.nanoTime();
        try {
            if (paused) {
                if (!recorder.resume()) throw new IllegalStateException("resume");
                started = System.nanoTime();
                paused = false;
                title.setText("录音中");
                pause.setText("暂停");
                tick();
            } else {
                if (!recorder.pause()) throw new IllegalStateException("pause");
                recordedNanos += now - started;
                paused = true;
                if (clock != null) clock.revoke();
                renderTime(recordedNanos);
                title.setText("已暂停");
                pause.setText("继续");
            }
            status.setText("");
        } catch (RuntimeException | LinkageError error) {
            HiLog.error(LOG, "Recorder pause/resume failed: %{public}s", error.getClass().getSimpleName());
            status.setText(paused ? "继续录音失败" : "暂停录音失败");
        }
    }

    private void tick() {
        if (recorder == null || paused) return;
        int seconds = renderTime(recordedNanos + System.nanoTime() - started);
        if (seconds >= MAX_SECONDS) stopRecording();
        else clock = getUITaskDispatcher().delayDispatch(this::tick, 250);
    }

    private int renderTime(long nanos) {
        int seconds = (int) Math.min(MAX_SECONDS, nanos / 1_000_000_000L);
        elapsed.setText(String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60));
        return seconds;
    }

    private void stopRecording() {
        Recorder active = recorder;
        if (active == null) return;
        if (!paused) renderTime(recordedNanos + System.nanoTime() - started);
        recorder = null;
        if (clock != null) clock.revoke();
        getWindow().clearWindowFlags(MARK_SCREEN_ON_ALWAYS);
        title.setText("飞录");
        recordingActions.setVisibility(Button.HIDE);
        start.setVisibility(Button.VISIBLE);
        libraryButton.setVisibility(Button.VISIBLE);

        boolean stopped = false;
        try {
            stopped = active.stop();
        } catch (RuntimeException | LinkageError error) {
            HiLog.error(LOG, "Recorder stop failed: %{public}s", error.getClass().getSimpleName());
        } finally {
            active.release();
        }
        String name = capture.getName();
        File ready = new File(directory, name.substring(0, name.length() - ".part".length()));
        if (stopped && capture.length() >= 16 && capture.renameTo(ready)) {
            status.setText("录音已保存");
        } else {
            status.setText("录音未正常保存");
        }
        syncPending(false);
    }

    private void syncPending(boolean retryFailed) {
        if (!visible || destroyed) return;
        if (syncing) {
            syncAgain = true;
            return;
        }
        if (poll != null) poll.revoke();
        syncing = true;
        retry.setVisibility(Button.HIDE);
        ARCHIVE_WORKER.execute(() -> {
            RecordingArchive.Summary result = RecordingArchive.sync(this, directory, retryFailed);
            getUITaskDispatcher().asyncDispatch(() -> {
                syncing = false;
                if (!visible || destroyed) return;
                delivery.setText(result.message);
                retry.setVisibility(result.canRetry ? Button.VISIBLE : Button.HIDE);
                if (library != null) library.refreshStatuses();
                if (syncAgain) {
                    syncAgain = false;
                    syncPending(false);
                } else if (result.retryAfterMs > 0) {
                    poll = getUITaskDispatcher().delayDispatch(() -> syncPending(false), result.retryAfterMs);
                }
            });
        });
    }

    Text text(String value, int size, int color) {
        Text text = new Text(this);
        text.setText(value);
        text.setTextSize(px(size));
        text.setTextColor(new Color(color));
        text.setTextAlignment(TextAlignment.CENTER);
        text.setLayoutConfig(new DirectionalLayout.LayoutConfig(px(305), MATCH_CONTENT));
        return text;
    }

    Button button(String value, int width, int height, int color) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextAlignment(TextAlignment.CENTER);
        button.setTextSize(px(26));
        button.setTextColor(new Color(0xff102620));
        button.setLayoutConfig(new DirectionalLayout.LayoutConfig(px(width), px(height)));
        button.setBackground(background(color, px(height) / 2));
        return button;
    }

    StackLayout actionRow(Button left, Button right, int width, int buttonWidth, int height) {
        StackLayout row = new StackLayout(this);
        row.setLayoutConfig(new DirectionalLayout.LayoutConfig(px(width), px(height)));
        row.addComponent(left, new StackLayout.LayoutConfig(px(buttonWidth), px(height),
                LayoutAlignment.LEFT | LayoutAlignment.VERTICAL_CENTER));
        row.addComponent(right, new StackLayout.LayoutConfig(px(buttonWidth), px(height),
                LayoutAlignment.RIGHT | LayoutAlignment.VERTICAL_CENTER));
        return row;
    }

    int px(int designPixels) {
        return Math.round(designPixels * scale);
    }

    static ShapeElement background(int argb, int radius) {
        ShapeElement shape = new ShapeElement();
        shape.setRgbColor(RgbColor.fromArgbInt(argb));
        shape.setCornerRadius(radius);
        return shape;
    }
}
