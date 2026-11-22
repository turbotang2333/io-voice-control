# Connect a computer agent

**English** &nbsp; [简体中文](../connect-computer.md)

Pair RayNeo iO with a Windows computer to open conversations, send tasks by voice, and read replies in your glasses.

## 1. Install and start

1. Install the modified RayNeo app on your Android phone and check that the glasses are paired with the phone.
2. Install RayNeo iO Connector on Windows. Open the Codex desktop app and sign in, or start Paseo and check that the agent you want can run there. Claude Code and OpenCode connect through Paseo, and their compatibility is still being tested.
3. Open the connector. If it hasn't detected your desktop app, click **Refresh status**.

[RayNeo app and Windows connector releases](https://github.com/turbotang2333/io-voice-control/releases) &nbsp; [Paseo releases](https://github.com/getpaseo/paseo/releases)

The first Windows installer is unsigned, so Windows may show an unknown publisher. Download it from the project releases page.

> The modified and official RayNeo apps use different signatures. You may need to uninstall the official app first. Back up any local data you want to keep.

## 2. Choose a relay

The phone and computer connect through a relay. Set up one of the following options before pairing.

The modified RayNeo app and connector currently use Chinese interface labels. The steps below include those labels in parentheses.

### Use the hosted relay

Get a test code by [direct message on Xiaohongshu](https://www.xiaohongshu.com/user/profile/5d483e2b00000000120086a2) or [email (turbotang2333@gmail.com)](mailto:turbotang2333@gmail.com).

In the connector, choose **Use the hosted relay** (使用作者中转), click **Connect and pair** (连接并配对), enter the test code, then choose **Confirm and connect** (确认并连接).

### Host your own relay

1. Prepare a Linux server with administrator access and a public IPv4 address or domain name. Allow TCP ports 443 and 2222 in the firewall and, if applicable, the cloud security group.
2. Choose **Use your own server** (使用自己的服务器), enter the server address, and click **Generate install command** (生成安装命令).
3. Sign in to the server and run the generated command there. Leave the connector and server terminal open while the connector finishes setup. The command contains one-time credentials.
4. Check the connection status. If installation succeeded on the server but the connector didn't receive the result, follow **Manual configuration package** (手动配置包方式) in the connector.

The public IPv4 flow has been checked up to a successful PC connection and a pairing QR code. Scanning the code and running an agent conversation still need testing with the release build.

## 3. Pair and try it

1. When the connector shows that the PC is connected, choose **Generate pairing QR code** (生成配对二维码).
2. On your phone, open the RayNeo app. Go to **Assistant settings → Scan to pair with a computer** (助手设置 → 扫码配对电脑), scan the code, and confirm.
3. In **Assistant settings**, select Codex or Paseo and choose **Check connection** (检查连接). Try the voice command for recent conversations (最近对话).

Keep the computer powered on and online. If the QR code expires, generate a new one in the connector.

The glasses have sometimes disconnected on wake-up during testing. After setup, the connector currently has no in-app option to switch relay modes.

## Update the Windows connector

Download the new installer from the project releases page, quit the connector from the Windows notification area, and run the installer against the existing installation location. Compatible versions update in place. If the installer reports an incompatible runtime or setup file, it keeps the existing installation. Follow the instructions in the new release notes.

[Back to the project homepage](../../README.en.md)
