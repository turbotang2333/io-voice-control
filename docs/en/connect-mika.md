# Connect Mika to control your phone

**English** &nbsp; [简体中文](../connect-mika.md)

Install the modified RayNeo app and Mika on the same Android phone. The glasses send voice tasks through the RayNeo app, and Mika operates the apps on the phone.

## 1. Install and set up Mika

1. Install the modified RayNeo app and check that the glasses are paired with the phone.
2. Install Mika. Configure a model in **Settings → Models**, then follow Mika's **Set up phone control** wizard.

[RayNeo app releases](https://github.com/turbotang2333/io-voice-control/releases) &nbsp; [Mika releases](https://github.com/wangzan101/Mika/releases) &nbsp; [Mika setup guide](https://github.com/wangzan101/Mika/blob/main/docs/setup-guide.en.md)

> The modified and official RayNeo apps use different signatures. You may need to uninstall the official app first. Back up any local data you want to keep.

## 2. Connect Mika in the RayNeo app

1. In Mika, go to **Settings → Connect a computer**, turn on **Network access**, and copy the access token.
2. In the RayNeo app, open **Assistant settings** (助手设置) and select **Mika**. The settings dialog opens on the first connection. To change an existing setup, choose **Edit settings** (编辑参数).
3. Paste the access token. The default port is `8765`. If you changed it in Mika, enter the current port shown there. Choose **Save and switch** (保存并切换).

## 3. Check the connection and try it

In the Mika tab of the RayNeo app, choose **Check connection** (检查连接). Once connected, describe a task to the glasses. You can follow up after Mika responds or start a new task.

If the check fails, verify that network access is on in Mika and that the port and token match. The connection to Mika has been checked. Phone tasks still need testing with the release build and the public Mika release.

[Back to the project homepage](../../README.md)
