# 连接 Mika 操控手机

[English](en/connect-mika.md) &nbsp; **简体中文**

在同一部安卓手机上安装改造版雷鸟 App 和 Mika。雷鸟 iO 通过雷鸟 App 把语音任务交给 Mika，由 Mika 操作手机上的 App。这条路线可以只用眼镜和手机。

## 1. 安装并准备 Mika

1. 安装改造版雷鸟 App，并确认雷鸟 iO 已和手机连接。
2. 安装 Mika。在「设置 → 模型」中配置可用的模型，再按 Mika 的「设置手机操作」向导完成手机操作权限配置。

[下载改造版雷鸟 App](https://github.com/turbotang2333/io-voice-control/releases)　[下载 Mika](https://github.com/wangzan101/Mika/releases)　[Mika 手机操作设置指南](https://github.com/wangzan101/Mika/blob/main/docs/setup-guide.md)

> 改造版雷鸟 App 和官方版签名不同。首次安装可能需要卸载官方版，卸载前请备份要保留的本地数据。

## 2. 在雷鸟 App 中连接 Mika

1. 打开 Mika 的「设置 → 连接电脑」，开启「网络访问」，复制访问令牌。这个令牌用于授权雷鸟 App 连接 Mika。
2. 打开雷鸟 App 的「助手设置」，选择「Mika」。首次连接会打开配置窗口，已配置时可点「编辑参数」。
3. 粘贴访问令牌。端口默认为 `8765`，如果在 Mika 中改过端口，请填 Mika 当前显示的端口。点击「保存并切换」。

## 3. 检查连接并试用

在雷鸟 App 的 Mika 页面点击「检查连接」。连接通过后，可以戴上眼镜，用一句自然语言交代任务。收到反馈后，可继续补充指令或开始新任务。

如果连接失败，先核对 Mika 的网络访问开关、端口和访问令牌。目前已验证连接，仍需用最终安装包和 Mika 正式版测试手机任务。

[返回项目首页](../README.zh-CN.md)
