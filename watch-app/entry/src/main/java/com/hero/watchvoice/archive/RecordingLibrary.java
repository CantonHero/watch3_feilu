package com.hero.watchvoice.archive;

import static ohos.agp.components.ComponentContainer.LayoutConfig.MATCH_CONTENT;
import static ohos.agp.components.ComponentContainer.LayoutConfig.MATCH_PARENT;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import ohos.agp.components.Button;
import ohos.agp.components.DirectionalLayout;
import ohos.agp.components.ScrollView;
import ohos.agp.components.StackLayout;
import ohos.agp.components.Text;
import ohos.agp.utils.LayoutAlignment;
import ohos.app.dispatcher.task.Revocable;
import ohos.media.common.Source;
import ohos.media.photokit.metadata.AVMetadataHelper;
import ohos.media.player.Player;

final class RecordingLibrary {
    private final MainAbility ability;
    private final File directory;
    private final StackLayout root;
    private final DirectionalLayout rows;
    private final Text message;
    private final Runnable onDelete;
    private final Map<File, Text> statuses = new HashMap<>();
    private final SimpleDateFormat dates = new SimpleDateFormat("MM-dd HH:mm", Locale.ROOT);

    private Player player;
    private FileInputStream stream;
    private File playing;
    private Button playingButton;
    private Revocable playbackWatch;
    private StackLayout confirmation;
    private boolean closed;

    RecordingLibrary(MainAbility ability, File directory, Runnable goBack, Runnable onDelete) {
        this.ability = ability;
        this.directory = directory;
        this.onDelete = onDelete;
        root = new StackLayout(ability);
        root.setLayoutConfig(new StackLayout.LayoutConfig(MATCH_PARENT, MATCH_PARENT));
        DirectionalLayout screen = column(MATCH_PARENT, MATCH_PARENT);
        screen.setBackground(MainAbility.background(0xff111519, 0));
        root.addComponent(screen, new StackLayout.LayoutConfig(MATCH_PARENT, MATCH_PARENT));

        Text heading = ability.text("录音列表", 29, MainAbility.PALE);
        heading.setLayoutConfig(new DirectionalLayout.LayoutConfig(ability.px(306), ability.px(43)));
        screen.addComponent(heading);

        ScrollView scroll = new ScrollView(ability);
        scroll.setLayoutConfig(new DirectionalLayout.LayoutConfig(ability.px(328), ability.px(237)));
        rows = column(MATCH_PARENT, MATCH_CONTENT);
        scroll.addComponent(rows, new StackLayout.LayoutConfig(MATCH_PARENT, MATCH_CONTENT));
        screen.addComponent(scroll);

        message = ability.text("", 18, MainAbility.PALE);
        screen.addComponent(message);
        Button back = ability.button("返回", 130, 42, MainAbility.PALE);
        back.setClickedListener(component -> goBack.run());
        screen.addComponent(back);
        refresh();
    }

    StackLayout view() {
        return root;
    }

    void close() {
        closed = true;
        cancelConfirmation();
        stopPlayback();
    }

    void refreshStatuses() {
        statuses.forEach((file, status) -> status.setText(RecordingArchive.statusLabel(file)));
    }

    private void refresh() {
        stopPlayback();
        rows.removeAllComponents();
        statuses.clear();
        File[] recordings = RecordingArchive.recordings(directory);
        if (recordings.length == 0) {
            rows.addComponent(ability.text("还没有录音", 22, MainAbility.PALE));
        } else {
            for (File file : recordings) rows.addComponent(recordingRow(file));
        }
    }

    private DirectionalLayout recordingRow(File file) {
        DirectionalLayout row = column(ability.px(320), MATCH_CONTENT);
        row.setPadding(0, ability.px(7), 0, ability.px(9));
        row.setBackground(MainAbility.background(0xff222a30, ability.px(16)));
        DirectionalLayout.LayoutConfig placement = new DirectionalLayout.LayoutConfig(ability.px(320), MATCH_CONTENT);
        placement.setMarginBottom(ability.px(8));
        row.setLayoutConfig(placement);

        long started = Long.parseLong(file.getName().substring(6, 19));
        Text time = ability.text(dates.format(new Date(started)) + "    " + duration(file), 23, 0xfff5f7f8);
        Text status = ability.text(RecordingArchive.statusLabel(file), 18, MainAbility.PALE);
        statuses.put(file, status);
        Button play = ability.button("播放", 135, 45, MainAbility.MINT);
        play.setClickedListener(component -> togglePlayback(file, play));
        Button delete = ability.button("删除", 135, 45, MainAbility.RED);
        delete.setClickedListener(component -> confirmDelete(file));
        row.addComponent(time);
        row.addComponent(status);
        row.addComponent(ability.actionRow(play, delete, 286, 135, 45));
        return row;
    }

    private DirectionalLayout column(int width, int height) {
        DirectionalLayout layout = new DirectionalLayout(ability);
        layout.setOrientation(1);
        layout.setAlignment(LayoutAlignment.CENTER);
        layout.setLayoutConfig(new DirectionalLayout.LayoutConfig(width, height));
        return layout;
    }

    private static String duration(File file) {
        AVMetadataHelper helper = null;
        try {
            helper = new AVMetadataHelper();
            if (helper.setSource(file.getAbsolutePath())) {
                String value = helper.resolveMetadata(AVMetadataHelper.AV_KEY_DURATION);
                if (value != null) {
                    long seconds = Math.round(Long.parseLong(value) / 1000.0);
                    return String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60);
                }
            }
        } catch (RuntimeException | LinkageError error) {
            return "--:--";
        } finally {
            if (helper != null) helper.release();
        }
        return "--:--";
    }

    private void togglePlayback(File file, Button button) {
        boolean wasPlaying = file.equals(playing);
        stopPlayback();
        if (wasPlaying) return;
        message.setText("");
        try {
            stream = new FileInputStream(file);
            player = new Player(ability);
            if (!player.setSource(new Source(stream.getFD())) || !player.prepare() || !player.play()) {
                throw new IOException("play");
            }
            playing = file;
            playingButton = button;
            button.setText("停止播放");
            playbackWatch = ability.getUITaskDispatcher().delayDispatch(this::checkPlayback, 400);
        } catch (IOException | RuntimeException | LinkageError error) {
            stopPlayback();
            message.setText("无法播放此录音");
        }
    }

    private void checkPlayback() {
        if (player != null && player.isNowPlaying()) {
            playbackWatch = ability.getUITaskDispatcher().delayDispatch(this::checkPlayback, 300);
        } else {
            stopPlayback();
        }
    }

    void stopPlayback() {
        if (playbackWatch != null) playbackWatch.revoke();
        if (player != null) player.release();
        if (stream != null) {
            try {
                stream.close();
            } catch (IOException ignored) {
                // The player has released the media source.
            }
        }
        if (playingButton != null) playingButton.setText("播放");
        player = null;
        stream = null;
        playing = null;
        playingButton = null;
    }

    private void confirmDelete(File file) {
        if (confirmation != null) return;
        confirmation = new StackLayout(ability);
        confirmation.setBackground(MainAbility.background(0xb8000000, 0));
        confirmation.setClickedListener(component -> cancelConfirmation());

        DirectionalLayout panel = column(ability.px(298), ability.px(174));
        panel.setBackground(MainAbility.background(0xff222a30, ability.px(27)));
        panel.setClickable(true);
        Text heading = ability.text("删除这条录音？", 25, 0xfff5f7f8);
        heading.setLayoutConfig(new DirectionalLayout.LayoutConfig(ability.px(262), ability.px(40)));
        Text details = ability.text("将删除手表上的音频", 18, MainAbility.PALE);
        details.setLayoutConfig(new DirectionalLayout.LayoutConfig(ability.px(262), ability.px(34)));

        Button cancel = ability.button("取消", 116, 53, MainAbility.PALE);
        cancel.setClickedListener(component -> cancelConfirmation());
        Button delete = ability.button("删除", 116, 53, MainAbility.RED);
        delete.setClickedListener(component -> deleteRecording(file));
        panel.addComponent(heading);
        panel.addComponent(details);
        panel.addComponent(ability.actionRow(cancel, delete, 248, 116, 53));
        confirmation.addComponent(panel, new StackLayout.LayoutConfig(ability.px(298), ability.px(174), LayoutAlignment.CENTER));
        root.addComponent(confirmation, new StackLayout.LayoutConfig(MATCH_PARENT, MATCH_PARENT));
    }

    boolean cancelConfirmation() {
        if (confirmation == null) return false;
        root.removeComponent(confirmation);
        confirmation = null;
        return true;
    }

    private void deleteRecording(File file) {
        cancelConfirmation();
        if (file.equals(playing)) stopPlayback();
        message.setText("正在删除");
        MainAbility.ARCHIVE_WORKER.execute(() -> {
            boolean deleted = RecordingArchive.delete(file);
            ability.getUITaskDispatcher().asyncDispatch(() -> {
                if (closed) return;
                message.setText(deleted ? "录音已删除" : "无法删除此录音");
                if (deleted) {
                    refresh();
                    onDelete.run();
                }
            });
        });
    }
}
