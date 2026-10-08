# CodexGPT Bridge

**ChatGPT の Web モデルを Codex で使用できます。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge は Codex を、ログイン済みの ChatGPT Web セッションに接続します。
モデルの選択、タスクごとの会話、画像、進捗表示、キャンセルに対応しています。
プロジェクトファイル、ツール、承認は Codex が管理します。

本プロジェクトは独立した第三者のプロジェクトであり、OpenAI とは提携していません。

GPT プラグインと Full MCP の設定手順：[English](README.md#chatgpt-plugin-setup) · [繁體中文](README.zh-TW.md#chatgpt-外掛設定)。

## インストール

このリポジトリの **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** ページから、OS に対応するインストーラーをダウンロードしてください。
Windows は `CodexGPT-Bridge-Setup-<バージョン>.exe`、macOS は DMG、
Linux は AppImage または DEB を使用します。

Codex がインストールされており、使用するモデルにアクセスできる ChatGPT アカウントが必要です。
利用できるモデルと使用量の上限はアカウントによって異なります。

## はじめに

1. Bridge を開き、ブラウザーとツールの接続方法を選択します。
   初めて使う場合は Simple を選ぶと簡単です。Full MCP にはコネクターと tunnel の設定が必要です。
2. 「ChatGPT ログインを開く」を選び、ログインします。Chrome でログインした場合は、
   Bridge に戻って「ログイン完了、続行」を選択します。
3. 「ChatGPT 接続をテスト」を選び、続いて「Web モデルをインストール」を選択します。
4. Codex を再起動し、`CodexGPT Bridge — …` モデルを選択します。

モデルを使用する間は Bridge を実行したままにしてください。
メインウィンドウを閉じるとシステムトレイに残り、「終了」で停止します。
「Web モデルを削除」は Bridge が管理していた設定を元に戻します。

画面は英語、繁体字中国語、簡体字中国語、日本語、韓国語に対応しています。
「言語」メニューから切り替えられます。

## 更新とトラブルシューティング

GitHub のリリースワークフローは、このリポジトリの更新 URL をインストーラーに組み込みます。
ユーザーが更新 URL を入力する必要はありません。
Bridge は起動時とバックグラウンドで新しいバージョンを確認します。
オンライン更新にはアクセス可能な更新マニフェストとインストーラーが必要です。
更新元がまだ利用できない場合は、**[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** から新しいバージョンをダウンロードしてください。

接続に失敗した場合は、ChatGPT のログイン状態を確認してから Bridge の **Doctor** 診断を実行してください。
問題を報告する際は、アプリのバージョン、OS、再現手順を記載し、
アカウント情報、個人用のパス、会話内容、認証情報を削除してください。

ログインデータと設定は、アプリのローカルユーザープロファイルに保存されます。

## ソースコードから起動

Node.js 22.20.0 以降と pnpm 11.19.0 を使用してください。

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## サードパーティーのライセンス

依存パッケージのライセンスは [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
と `LICENSES/` に記載されています。本プロジェクトのライセンスはまだ選択されていません。
