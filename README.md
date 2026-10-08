# CodexGPT Bridge

**Bring ChatGPT Web models into Codex.**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge connects Codex to your signed-in ChatGPT Web session. It supports
model selection, separate task conversations, images, progress and cancellation.
Codex handles project files, tools and approvals.

This is an independent third-party project, unaffiliated with OpenAI.

## Install

Download the installer for your operating system from this repository's
**[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** page. Windows uses the `CodexGPT-Bridge-Setup-<version>.exe` installer;
macOS uses a DMG and Linux uses an AppImage or DEB.

You need Codex and a ChatGPT account with access to the models you want to use.
Available models and usage limits depend on your account.

## Get started

1. Open Bridge and choose your browser and tool connection. Simple mode is the
   quickest way to start; Full MCP requires its connector and tunnel setup.
2. Choose **Open ChatGPT login** and sign in. For Chrome, return to Bridge and
   choose **Sign-in complete, continue** when finished.
3. Choose **Test ChatGPT connection**, then **Install Web models**.
4. Restart Codex and select a `CodexGPT Bridge — …` model.

Keep Bridge running while using its models. Closing the window leaves it in the
system tray; **Quit** stops it. **Remove Web models** restores the settings
previously managed by Bridge.

The interface supports English, Traditional Chinese, Simplified Chinese,
Japanese and Korean. Use the **Language** menu to switch.

## Updates and troubleshooting

The GitHub release workflow bundles this repository's update feed into installers,
so users do not need to enter an update URL.
Bridge checks for new versions at startup and in the background. Updates require
an accessible release feed and installer; until that feed is available, download
new versions from **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)**.

If the connection fails, check your ChatGPT login and use Bridge's **Doctor**
diagnostics. Include your app version, operating system and steps to reproduce
when reporting a problem. Remove account details, private paths, conversation
contents and credentials from reports.

Login data and settings remain in the application's local user profile.

## Build from source

Use Node.js 22.20.0 or newer and pnpm 11.19.0:

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## Third-party notices

Dependency licenses are included in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
and `LICENSES/`. The project license has not been selected.
