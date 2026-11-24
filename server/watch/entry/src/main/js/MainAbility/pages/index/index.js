import featureAbility from '@ohos.ability.featureAbility';
import {
  archiveRecording, openRecorder, pendingRecordings, relayConfigured,
} from '../../common/recordings';

const MAX_SECONDS = 300;
const MIC_PERMISSION = 'ohos.permission.MICROPHONE';

function elapsedText(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return ('0' + minutes).slice(-2) + ':' + ('0' + remainder).slice(-2);
}

export default {
  data: {
    recording: false,
    busy: false,
    elapsed: '00:00',
    info: '',
    delivery: '',
    canRetry: false,
  },

  async onShow() {
    this.visible = true;
    if (this.initialized) {
      if (this.startWhenVisible) {
        this.startWhenVisible = false;
        await this.startRecording();
      }
      if (this.dir) this.syncPending();
      return;
    }
    this.initialized = true;
    await this.startRecording();
    this.syncPending();
  },

  onHide() {
    this.visible = false;
    clearTimeout(this.pollTimer);
    // Permission dialogs can also hide the page. The start path waits for the result.
    if (this.recorder) this.stopRecording();
  },

  onDestroy() {
    this.visible = false;
    this.destroyed = true;
    clearTimeout(this.pollTimer);
    if (this.recorder) this.stopRecording();
  },

  async startRecording() {
    if (this.busy || this.recorder || !this.visible || this.destroyed) return;
    this.busy = true;
    this.info = '正在启动录音';
    this.elapsed = '00:00';
    let step = '录音目录不可用';
    try {
      if (!this.context) this.context = featureAbility.getContext();
      if (!this.dir) this.dir = await this.context.getFilesDir();
      if (typeof this.dir !== 'string' || !this.dir) throw new Error('No recording directory');
      step = '请检查麦克风权限';
      if (typeof this.context.requestPermissionsFromUser === 'function') {
        const permission = await this.context.requestPermissionsFromUser([MIC_PERMISSION], 1);
        if (!permission.authResults || permission.authResults[0] !== 0) {
          this.info = '请允许麦克风';
          return;
        }
      }
      if (this.destroyed) return;
      if (!this.visible) {
        this.startWhenVisible = true;
        return;
      }
      this.recorder = await openRecorder(this.dir, () => this.stopRecording());
      if (this.destroyed || !this.visible) {
        await this.stopRecording();
        return;
      }
      this.recording = true;
      this.info = '';
      const startedAt = Date.now();
      this.clock = setInterval(() => {
        const seconds = Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAt) / 1000));
        this.elapsed = elapsedText(seconds);
        if (seconds >= MAX_SECONDS) this.stopRecording();
      }, 250);
    } catch (error) {
      this.info = '录音启动失败 · ' + step;
      console.error('Recorder start failed: ' + (error && (error.message || error.code) || String(error)));
    } finally {
      this.busy = false;
    }
  },

  async stopRecording() {
    if (!this.recorder) return;
    const recorder = this.recorder;
    this.recorder = undefined;
    clearInterval(this.clock);
    this.busy = true;
    this.recording = false;
    try {
      await recorder.stop();
      this.info = '录音已保存';
    } catch (error) {
      this.info = '录音未正常结束';
      console.error('Recorder stop failed: ' + (error && (error.message || error.code) || String(error)));
    } finally {
      this.busy = false;
    }
    if (this.syncing) this.syncAgain = true;
    else this.syncPending();
  },

  retryPending() {
    this.syncPending(true);
  },

  async syncPending(retryFailed = false) {
    if (this.syncing || !this.dir || !this.visible || this.destroyed) return;
    clearTimeout(this.pollTimer);
    this.syncing = true;
    this.canRetry = false;
    try {
      const names = pendingRecordings(this.dir);
      if (!names.length) return;
      if (!relayConfigured()) {
        this.delivery = '待发送 ' + names.length + ' · 未配置连接';
        return;
      }
      this.delivery = '正在发送';
      let stored = 0;
      let processing = 0;
      let tested = 0;
      let review = 0;
      let noSpeech = 0;
      for (const name of names) {
        if (!this.visible || this.destroyed) break;
        const result = await archiveRecording(this.dir, name, retryFailed);
        if (result === 'retry') break;
        if (result === 'review') review++;
        if (result === 'no_speech') noSpeech++;
        if (result === 'test_received') tested++;
        if (result === 'processing') processing++;
        if (result === 'stored') stored++;
      }
      const remaining = pendingRecordings(this.dir).length;
      if (processing) this.delivery = '服务器正在转写';
      else if (review) this.delivery = '转写待检查 ' + review;
      else if (noSpeech) this.delivery = '未识别到讲话 · 录音保留';
      else if (tested) this.delivery = '测试已接收 · 录音保留';
      else if (remaining) this.delivery = '待发送 ' + remaining;
      else if (stored) this.delivery = '文字已保存';
      this.canRetry = remaining > 0;
      if (processing && this.visible && !this.destroyed) {
        this.pollTimer = setTimeout(() => this.syncPending(), 5000);
      }
    } catch (error) {
      this.delivery = '发送失败 · 录音保留';
      this.canRetry = true;
    } finally {
      this.syncing = false;
      if (this.syncAgain) {
        this.syncAgain = false;
        this.syncPending();
      }
    }
  },
};
