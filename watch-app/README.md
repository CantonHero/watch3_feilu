# 飞录 · WATCH 3 手表端

目标设备是 HUAWEI WATCH 3 GLL-AL30，系统版本为 HarmonyOS 4.0.0.409，设备上报的应用 API 为 6。当前版本 0.3.15 使用华为 Java FA 和原生 `Recorder` 录音接口，包名为 `com.hero.watchvoice.archive`。打开后点「开始录音」才会启用麦克风。暂停冻结计时，继续写入同一段，停止保存并加入上传队列。录音列表展示时长和上传状态，支持回听和删除表内音频。上传后的表内音频保留到手动删除。

飞录需要手表处于智能模式。WATCH 3 进入超长续航模式时主处理器断电，华为兼容性表将该模式的第三方应用和系统语音备忘录均列为不支持。开发签名或重新打包无法改变这一模式限制。 [华为双芯切换说明](https://consumer.huawei.com/cn/support/content/zh-cn15818824/) · [华为双模式功能对照](https://consumer.huawei.com/cn/support/content/zh-cn15953888/)

## 构建

使用 HarmonyOS SDK 2.2.0.3 的 JS、Java 和 Toolchains，以及 JDK 17、Node.js 16.20.2 和 Gradle 7.3。在工程根目录的 `local.properties` 设置 `hwsdk.dir`、`nodejs.dir`、`npm.dir` 为实际本机目录。将 `HOS_SDK_HOME` 指向 HarmonyOS SDK 根目录。运行 `gradle :entry:packageDebugHap` 打包，然后使用华为签名工具签名。旧插件在 JDK 17 内生成兼容层签名时，给构建进程增加 `--add-exports=java.base/sun.security.tools.keytool=ALL-UNNAMED` 和 `--add-exports=java.base/sun.security.x509=ALL-UNNAMED`。 [华为 API 4–7 命令行构建文档](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V2/command-line-building-app-hap-gradle-0000001193655754-V2/)

SDK 附带的旧 JS 编译器锁文件中有已失效的华为内部测试依赖。联调环境保留官方编译器，用公共 npm 源获取原版本和原完整性校验值对应的编译依赖，移除了编译过程不使用的 `deccjsunit` 测试依赖。

使用这块手表对应的调试证书及设备 Profile 签名。在工程的 `entry/build` 下可找到华为 Gradle 插件生成的中间产物 `entry-debug-rich-unsigned.hap`。联调时用官方 `hapsigntoolv2.jar` 对这一 HAP 进行签名，核对 v2 签名、摘要和设备 Profile，再用华为 HDC 安装。GLL-AL30 的应用管理器已确认安装记录。 [华为穿戴设备调试说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V2/run_smartwatch-0000001052902433-V2/)

## 配置服务器

随附源码默认可用于验证录音与手表本地保存。接入服务器时，在配套「录音转文字」源码根目录设置 `WATCH_RELAY_URL` 和 `WATCH_TOKEN`，运行 `node watch/prepare-project.mjs "<本工程目录>"` 写入连接配置，再重新编译、签名和安装。可通过 `WATCH_RELAY_IPV4` 配置经过 DNS 核对的服务器备用 IPv4，仍按原域名验证 HTTPS 证书。服务器将转写保存为简体中文 `.txt`。部署步骤见项目根目录的 README。配置前将工程复制到本机忽略的 `.work/` 目录，在副本中注入设备令牌后构建。
