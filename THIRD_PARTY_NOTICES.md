# 第三方软件说明

本项目自己的代码采用根目录的 MIT 许可证。第三方软件、模型、雷鸟官方 App 和 AI 助手仍适用各自的许可或使用条件。

| 项目或组件 | 用途 | 许可或说明 |
| --- | --- | --- |
| [Turbo-IO](https://github.com/Turbo1123/Turbo-IO/tree/f983669a2db1c2a658f7d4c50285b81aa074345a) | 安卓语音回调包装的实现参考，回复对象复制方法的代码改编 | 指定版本采用 [PolyForm Noncommercial 1.0.0](https://github.com/Turbo1123/Turbo-IO/blob/f983669a2db1c2a658f7d4c50285b81aa074345a/LICENSE)。分发时须随代码或安装包提供许可文本或许可网址，并保留[上游声明](https://github.com/Turbo1123/Turbo-IO/blob/f983669a2db1c2a658f7d4c50285b81aa074345a/NOTICE)中的 Required Notice。 |
| [OpenRayneo](https://github.com/Tobi1chi/OpenRayneo/blob/7f2fc0dbb4414fa66bdc5a1be23d44b7d4b4ec31/Sources/OpenRayneoBridge/main.swift) | 提词显示和传输协议的研究参考 | 该研究版本采用 [Apache 2.0](https://github.com/Tobi1chi/OpenRayneo/blob/7f2fc0dbb4414fa66bdc5a1be23d44b7d4b4ec31/LICENSE)。在已核对的实现中未发现直接引入其源码。 |
| [Paseo](https://github.com/getpaseo/paseo) | 连接电脑上的 AI 助手 | 项目使用的 0.13.0 版本以 Apache 2.0 发布；上游第三方组件适用各自许可。许可证见 `distribution/PASEO-LICENSE.txt`。 |
| [Mika](https://github.com/wangzan101/Mika) | 在安卓手机上执行任务，通过接口接入 | Apache 2.0；以实际使用或分发的版本及其许可文件为准。 |
| [ZXing](https://github.com/zxing/zxing) | 安卓扫码配对 | 使用 core 3.5.3；许可证见 `android-addon/assets/ZXING-LICENSE.txt`。 |
| [node-qrcode](https://github.com/soldair/node-qrcode) | 生成配对二维码 | MIT；许可文件随对应依赖提供。 |
| [node-tar](https://github.com/isaacs/node-tar) | 处理压缩包 | BlueOak-1.0.0；许可文件随对应依赖提供。 |
| [Node.js](https://nodejs.org/) | 电脑连接器运行环境 | 运行时及许可文件随电脑安装包提供；以实际打包版本为准。 |

电脑安装包还包含其他依赖，其许可文件保存在安装包的对应依赖目录。发布前需按最终安装包核对所有依赖和声明。

智能搜索是可选功能；其模型及依赖的许可需在对应功能包发布前单独核对。雷鸟官方 App 的程序与资源不属于本项目 MIT 许可证的授权范围。

## Turbo-IO 来源声明

Required Notice: Copyright (c) 2026 Turbo IO contributors

上游许可网址见 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。

改编代码位于 `android-addon/src/cn/yilu/rayneopaseo/ProbeAddon.java` 的 `copy` 方法。它在当前源码与已生成的公开候选源码中均保留。上游许可说明所列的[历史 MIT 快照](https://github.com/Turbo1123/Turbo-IO/tree/f78573e0f6298677ab50adba342e161c32e9de45)未包含该安卓实现。

## OpenRayneo 研究参考

参考记录见 `experiments/prompt-display/src/cn/yilu/rayneopaseo/ManuscriptTransfer.java`。该提词实验模块保留在候选源码中，标准 1.0.25 安卓构建不编译此模块。早期记录提到参考过音频研究，目前未定位到以 OpenRayneo 音频代码为来源的首发实现。
