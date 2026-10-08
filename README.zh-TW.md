# CodexGPT Bridge

**把 ChatGPT 網頁模型接入 Codex。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge 連接 Codex 與你已登入的 ChatGPT 網頁，支援模型選擇、
任務各自保留對話、圖片、進度顯示與取消。專案檔案、工具與核准由 Codex 管理。

本專案為獨立第三方專案，與 OpenAI 沒有隸屬關係。

## 安裝

從本倉庫的 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** 頁面下載適合你作業系統的安裝檔。
Windows 使用 `CodexGPT-Bridge-Setup-<版本>.exe`；macOS 使用 DMG；
Linux 使用 AppImage 或 DEB。

你需要已安裝的 Codex，以及可使用所需模型的 ChatGPT 帳號。
可用模型與使用額度依帳號而定。

## 開始使用

1. 開啟 Bridge，選擇瀏覽器與工具連線。初次使用可選 Simple；
   Full MCP 需要先完成連接器與 tunnel 設定。
2. 點選「開啟 ChatGPT 登入」並登入。Chrome 登入完成後，
   回到 Bridge 確認「登入完成，繼續」。
3. 點選「測試 ChatGPT 連線」，再「安裝 Web 模型」。
4. 重新啟動 Codex，選擇 `CodexGPT Bridge — …` 模型。

使用這些模型時請保持 Bridge 執行。關閉主視窗後程式會留在系統匣；
「結束」會停止程式。「移除 Web 模型」會還原先前由 Bridge 管理的設定。

介面支援英文、繁體中文、簡體中文、日文與韓文，可從「語言」選單切換。

## 更新與問題排查

GitHub 發布流程會將此倉庫的更新網址內建至安裝包，使用者不需手動設定。
Bridge 會在啟動與背景執行期間
檢查新版；線上更新需要可存取的更新清單與安裝檔。更新來源尚未可用時，
請從 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** 下載新版。

連線失敗時，先確認 ChatGPT 登入狀態，再執行 Bridge 的「Doctor」。
回報問題時請附上程式版本、作業系統與重現步驟，並移除帳號資料、
私人路徑、對話內容與憑證。

登入資料與設定儲存在應用程式的本機使用者設定檔。

## 從原始碼啟動

使用 Node.js 22.20.0 以上與 pnpm 11.19.0：

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

## 第三方授權

依賴套件的授權保留在 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
及 `LICENSES/`。本專案尚未選定授權條款。
