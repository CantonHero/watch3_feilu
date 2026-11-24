# 飞录 · 录音转文字服务

配套手表版本 0.3.15。目标真机报告型号为 HUAWEI WATCH 3 GLL-AL30，完整系统版本为 GLL-AL30CN 4.0.0.409(C00E381R1P381)。

在手表 App 中点「开始录音」后录制，单段累计有效录音最长 5 分钟。暂停冻结计时，可点「继续」录同一段。停录后手表先保存 M4A，经 HTTPS 上传到服务器。服务器可选择 MiniMax ASR 或本地模型，将转写结果保存为简体中文 `transcripts/watch-<录音编号>.txt`。手表收到文本保存回执后显示「已上传」。音频可在表上回听，保留至用户手动删除。手表的删除按钮只处理表内音频，已经归档的文本继续保存在服务器。

已用 Windows 本地模型和合成普通话验证上传、推理和 UTF-8 归档。0.3.15 在真机 Wi-Fi 下自动补传两条积压录音，经 MiniMax 转写后生成两份文本。此前联调包已验证两端关闭 Wi-Fi、手表关闭 eSIM 数据时，可通过 vivo 手机的移动数据回传音频。

## 日常录音上传

手表端使用系统提供的网络发送 HTTPS 请求，日常上传可走蓝牙共享的手机移动数据。华为说明，WATCH 3 通过华为运动健康与华为或 Android 手机保持蓝牙连接，且运动健康在后台运行时，可使用手机当前的移动数据。手表和手机都可关闭 Wi-Fi。服务器的 HTTPS 地址须能从移动网络访问。

如果配对的是 iPhone，华为说明 WATCH 3 无法通过蓝牙共享 iPhone 的网络。该场景可评估已开通的手表 eSIM 移动网络。两种链路均需实际确认这台手表上的 App 能发出 HTTPS 请求。断线时手表保留录音，下次打开 App 或点击重试时补传。

WLAN 调试用于把开发版 HAP 装到手表，以及后续调试或更新安装。这与日常上传所用网络独立，蓝牙连接安装本项目 HAP 的路径尚未验证。

## 部署服务器

1. 准备 Node.js 24 和持久磁盘。把 `relay/.env.example` 复制到源码根目录的 `.env`。设定 `RELAY_MODE=archive`，配置 `TRANSCRIPT_DIR`、`ARCHIVE_DB` 和独立的手表设备令牌 `WATCH_TOKEN`。可用 `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成令牌。
2. **MiniMax 模式**。执行 `npm ci --ignore-scripts` 安装简体转换依赖。设置 `ASR_PROVIDER=minimax`，通过服务器的密钥配置填写 `MINIMAX_API_KEY`。默认 `MINIMAX_REGION=cn`，国际账号设为 `global`。服务器会把录音提交给 MiniMax 的 `asr-1.0`，然后保存文字。Key 由服务器保管，语音提交涉及 MiniMax API 用量。此模式只需 Node.js。
3. **本地模式**。保留默认 `ASR_PROVIDER=local`。创建 Python 3.12 虚拟环境并执行 `python -m pip install -r relay/requirements.txt`。配置 `ASR_PYTHON` 和 `ASR_MODEL_DIR`，模型目录需要 `model.bin`、`tokenizer.json`、`config.json`。Windows 如有需要可用 `ASR_DLL_DIR` 指定 C++ 运行库目录。模型建议使用多语言 [Faster Whisper Small](https://huggingface.co/Systran/faster-whisper-small)。
4. 用 `node --env-file=.env relay/server.mjs` 启动单进程。服务监听 `127.0.0.1:8787`。同机反向代理使用手表信任的 HTTPS 证书，允许 GET 与 PUT 并原样转发 `/v1/recordings/`，请求体上限设为至少 6 MiB，以容纳 API 6 的 Base64 编码。通过服务器的进程管理器常驻运行。

`GET /health` 返回进程模式。`PUT /v1/recordings/<录音编号>` 接收 `audio/mp4` 或 API 6 使用的 `application/vnd.watch3.audio-base64`，同一个地址的 GET 查询归档状态。两个请求均使用设备令牌，单次音频解码后的上限为 4 MiB。接收服务用持久队列恢复未完成任务，转写结束后清除队列内的音频字段。测试模式接收测试音频并返回校验值。正式部署应限制文本和数据库目录的访问权限，并一起备份。

## 构建手表 App

1. 使用配套的 WATCH 3 原生 Java FA 工程和 HarmonyOS API 6 SDK。华为建议 HarmonyOS 4.x 设备使用 DevEco Studio 3.1.1 Release 进行连接调试。
2. 设置 `WATCH_RELAY_URL` 和对应的 `WATCH_TOKEN`，在本包根目录执行 `node watch/prepare-project.mjs "<手表工程目录>"`。脚本把 HTTPS 地址和设备令牌写入 `RelaySettings.java`。仅验证录音时可将两个变量留空。
3. 手表与电脑进入同一 WLAN，从手表的开发人员选项开启 WLAN 调试。使用支持该设备的华为调试证书及 Profile 签名，再安装 HAP。已经通过 DevEco Studio 自动签名生成本机调试证书与设备 Profile。

## 运行测试

`npm ci --ignore-scripts`

`node --test relay/server.test.mjs watch/recordings.test.mjs`

普通测试使用本机回环 HTTP、初版 JavaScript 客户端的模拟接口，以及模拟 MiniMax 和飞书接口。设置 `ASR_PYTHON` 和 `ASR_MODEL_DIR` 后，还会用本地模型转写配套合成普通话。可用 `ASR_TEST_AUDIO` 指定另一段含「手表」和「服务器」的样本。另附 30 秒合成纯音，用于验证传输和队列。真实飞书投递须启用应用机器人配置。

## 参考

- [华为关于 HarmonyOS 4.x 调试工具的说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/app-debugging-faq-0012/)
- [华为穿戴设备真机安装](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V3/run_smartwatch-0000001052902433-V3/)
- [华为 WATCH 3 的蓝牙、移动数据与 eSIM 联网方式](https://consumer.huawei.com/cn/support/content/zh-cn15818703/)
- [Faster Whisper 离线模型与 CPU 用法](https://github.com/SYSTRAN/faster-whisper)
- [MiniMax 语音识别接口](https://platform.minimax.cn/docs/api-reference/speech-to-text)
