# CodexGPT Bridge

**将 ChatGPT 网页模型接入 Codex。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge 将 Codex 连接到已登录的 ChatGPT 网页会话，支持模型选择、
独立的任务对话、图片、进度显示与取消。项目文件、工具和审批由 Codex 管理。

本项目是独立的第三方项目，与 OpenAI 没有隶属关系。

GPT 插件与 Full MCP 设置教程：[繁體中文](README.zh-TW.md#chatgpt-外掛設定) · [English](README.md#chatgpt-plugin-setup)。

## 安装

从本仓库的 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** 页面下载适合你的操作系统的安装包。
Windows 使用 `CodexGPT-Bridge-Setup-<版本>.exe`；macOS 使用 DMG；
Linux 使用 AppImage 或 DEB。

你需要已安装的 Codex，以及可以使用所需模型的 ChatGPT 账号。
可用模型与使用额度取决于账号。

## 开始使用

1. 打开 Bridge，选择浏览器与工具连接方式。首次使用可选择 Simple；
   Full MCP 需要先完成连接器与 tunnel 配置。
2. 点击“打开 ChatGPT 登录”并登录。Chrome 登录完成后，
   返回 Bridge，点击“登录完成，继续”。
3. 点击“测试 ChatGPT 连接”，然后点击“安装 Web 模型”。
4. 重新启动 Codex，选择 `CodexGPT Bridge — …` 模型。

使用这些模型时，请保持 Bridge 运行。关闭主窗口后，程序会留在系统托盘；
“退出”会停止程序。“移除 Web 模型”会恢复先前由 Bridge 管理的设置。

界面支持英语、繁体中文、简体中文、日语和韩语，可从“语言”菜单切换。

## 更新与问题排查

GitHub 发布流程会将本仓库的更新网址内置到安装包，用户不需要手动设置。
Bridge 会在启动和后台运行时检查新版本。在线更新需要可访问的更新清单与安装包；
更新源尚不可用时，请从 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** 下载新版本。

连接失败时，请先确认 ChatGPT 登录状态，再运行 Bridge 的 **Doctor** 诊断。
报告问题时，请附上程序版本、操作系统和复现步骤，并移除账号信息、
私人路径、对话内容和凭证。

登录数据与设置保存在应用程序的本地用户配置文件中。

## 从源代码启动

使用 Node.js 22.20.0 或更新版本，以及 pnpm 11.19.0：

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## 第三方许可

依赖包的许可证保存在 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
和 `LICENSES/` 中。本项目尚未选定许可证。
