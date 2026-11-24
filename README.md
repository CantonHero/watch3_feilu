# watch3_feilu · 飞录

![飞录图标](watch-app/entry/src/main/resources/base/media/app_icon.png)

飞录是面向华为 WATCH 3 的录音应用。按下键打开应用，点「开始录音」后录制，支持暂停、继续和停止。录音经 HTTPS 上传至自建服务，由 MiniMax ASR 或本地 Faster Whisper 转成简体中文，保存为 UTF-8 文本，并可通过飞书应用机器人发送到指定群。

当前手表版本为 **0.3.15**。开发与真机验证使用 WATCH 3 GLL-AL30、HarmonyOS 4.0.0.409、应用 API 6。

## 功能

- 手动开始录音，暂停与继续写入同一段，单段累计有效录音最长 5 分钟。
- 录音列表展示时长和上传状态，支持播放、删除及适配圆形手表屏幕的确认界面。
- 录音先保存于手表，断网时保留，应用打开及停录后尝试上传，前台失败后自动重试。
- 服务器持久化接收队列，自动转写并生成 `transcripts/watch-<录音编号>.txt`。
- 服务器确认文本落盘后，手表显示「已上传」。表内音频可继续回听和手动删除。
- 飞书投递使用持久队列，保存消息回执并为重试使用稳定的去重标识。
- 手表的 HTTPS 回退路径保留域名证书验证和 SNI，并支持通过 DoH 更新备用 IPv4。

## 工作流程

```mermaid
flowchart LR
    A[WATCH 3 飞录] -->|HTTPS 录音| B[公网 HTTPS 反向代理]
    A -. 蓝牙借用手机网络 .-> P[Android 手机移动数据]
    P -.-> B
    B --> C[本机 Node.js 接收服务]
    C --> D[MiniMax ASR 或本地 Faster Whisper]
    D --> E[UTF-8 文本归档]
    E --> F[可选飞书机器人群消息]
```

手机通过华为运动健康与手表保持蓝牙连接。此方式使用系统共享网络能力，项目不包含单独的手机中继 App。电脑接收器需持续运行，并拥有可从手机移动网络访问的 HTTPS 入口。

## 目录

| 路径 | 内容 |
| --- | --- |
| `watch-app/` | 已在真机运行的 Java FA 手表工程，HarmonyOS API 6 |
| `server/relay/` | Node.js 接收、MiniMax 与本地转写、SQLite 队列、飞书投递 |
| `server/watch/` | 配置准备工具、早期 JS FA 实现及客户端队列测试 |
| `server/relay/.env.example` | 服务端配置模板 |
| `server/relay/fixtures/` | 自动测试使用的合成语音和纯音 |

## 配置与运行

服务端需要 Node.js 24。本地转写另需 Python 环境和 Faster Whisper 模型。MiniMax 模式通过官方 API 发送录音进行识别，相关用量由账号承担。

```powershell
cd server
npm ci --ignore-scripts
Copy-Item relay/.env.example .env
```

在本机编辑 `.env`，设置 `RELAY_MODE=archive`，填写至少 32 位 URL 安全字符组成的随机 `WATCH_TOKEN`。使用 MiniMax 时设置 `ASR_PROVIDER=minimax`，填写 `MINIMAX_API_KEY`，国内账号选择 `MINIMAX_REGION=cn`。本地模型配置见 [服务端说明](server/README.md)。

```powershell
node --env-file=.env relay/server.mjs
```

服务监听 `127.0.0.1:8787`。将自有 HTTPS 反向代理或专用 Cloudflare Tunnel 指向该地址，转发 `/health` 和 `/v1/recordings/`，保留 `Authorization` 请求头并支持 GET、PUT。公网入口和电脑服务都需要保持可用。

准备手表安装包时，先把 `watch-app/` 复制到本机忽略的 `.work/` 下，在该副本注入 `WATCH_RELAY_URL` 与 `WATCH_TOKEN`，再编译和签名。服务器凭据由服务器保管。手表配置工具的用法见 [手表工程说明](watch-app/README.md)。

### 飞书群消息

创建并发布飞书企业自建应用，启用机器人，开通 `im:message:send_as_bot`，把机器人加入目标群。在 `.env` 填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID`，设置 `FEISHU_ENABLED=1` 后重启接收器。

启用后的新归档文本会进入投递队列。启用前已经归档的记录继续保存在本机。投递状态和消息回执保存在 SQLite 的 `feishu_outbox` 中，表上的「已上传」表示文本已在服务器归档。

## 编译与安装

工程使用旧版 HarmonyOS SDK API 6、华为 Java FA 和 Gradle 插件。较新的 SDK 与工具链需核对是否支持该版本。安装需要为目标手表配置华为调试证书和设备 Profile，通过 HDC 原位升级可保留原有录音。本项目已验证开发签名安装，无需将 App 上架应用商店。详细依赖和命令见 [手表构建说明](watch-app/README.md)。

## 验证范围

- 真机验证了录音、暂停、继续、停止、回听、删除、版本升级和旧录音补传。
- 联调包验证了手表与 Android 手机均关闭 Wi-Fi、手表关闭 eSIM 数据时，通过蓝牙借用手机移动数据回传音频。
- 0.3.15 已通过真机录音上传、真实 MiniMax 转写和本机文本归档验证。
- 飞书机器人已取得真实消息成功回执，用户确认群内收到文本。
- 自动测试覆盖鉴权、Base64 上传、持久队列恢复、幂等归档、转写重试和飞书投递。MiniMax 与飞书的自动测试采用模拟接口。
- 持续后台上传、不同手机厂商的后台策略、长时间熄屏录音和长周期耗电仍需进一步实测。当前 App 进入后台会停止录音并取消定时状态查询。

运行自动测试可使用下列命令。设置 `ASR_PYTHON`、`ASR_MODEL_DIR` 后会额外执行本地模型转写测试。

```powershell
cd server
node --test relay/server.test.mjs watch/recordings.test.mjs
```

## 续航与系统限制

WATCH 3 的超长续航模式会关闭主处理器，官方功能表将第三方应用和语音备忘录列为不支持。飞录需要智能模式。日常可关闭手表 WLAN、eSIM 数据及常亮显示，通过与 Android 手机的蓝牙连接上传。录音停止并显示「服务器正在转写」后，可返回表盘，电脑继续完成转写和群消息投递。 [华为模式切换说明](https://consumer.huawei.com/cn/support/content/zh-cn15818824/) · [华为功能对照](https://consumer.huawei.com/cn/support/content/zh-cn15953888/)

## 本机凭据和数据

配置通过 `.env.example` 创建。`.gitignore` 覆盖本机环境文件、录音与文本存储目录、SQLite 数据库、签名材料、构建包和本机部署记录。发布前应检查暂存文件，特别是配置工具生成的源码和带设备令牌的安装包。

录音会保留在表上至手动删除。服务器在转写完成后清除队列中的音频字段，保存文本及任务状态。具体服务数据的备份、删除和访问权限由部署者管理。
