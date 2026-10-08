# CodexGPT Bridge

**把 ChatGPT 網頁模型接入 Codex。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

CodexGPT Bridge 連接 Codex 與你已登入的 ChatGPT 網頁，支援模型選擇、
任務各自保留對話、圖片、進度顯示與取消。專案檔案、工具與核准由 Codex 管理。

本專案為獨立第三方專案，與 OpenAI 沒有隸屬關係。

要設定 GPT 外掛，請看下方的 **[ChatGPT 外掛設定](#chatgpt-外掛設定)**。

## 安裝

從本倉庫的 **[Releases](https://github.com/chrisfluxx/codexgpt-bridge/releases/latest)** 頁面下載適合你作業系統的安裝檔。
Windows 使用 `CodexGPT-Bridge-Setup-<版本>.exe`；macOS 使用 DMG；
Linux 使用 AppImage 或 DEB。

你需要已安裝的 Codex，以及可使用所需模型的 ChatGPT 帳號。
可用模型與使用額度依帳號而定。

## 開始使用

1. 開啟 Bridge，選擇瀏覽器與工具連線。初次使用可選 Simple；
   Full MCP 請依照下方的外掛與 Tunnel 教學完成設定。
2. 點選「開啟 ChatGPT 登入」並登入。Chrome 登入完成後，
   回到 Bridge 確認「登入完成，繼續」。
3. 點選「測試 ChatGPT 連線」，再「安裝 Web 模型」。
4. 重新啟動 Codex，選擇 `CodexGPT Bridge — …` 模型。

使用這些模型時請保持 Bridge 執行。關閉主視窗後程式會留在系統匣；
「結束」會停止程式。「移除 Web 模型」會還原先前由 Bridge 管理的設定。

介面支援英文、繁體中文、簡體中文、日文與韓文，可從「語言」選單切換。

## ChatGPT 外掛設定

這裡的 GPT 外掛是 ChatGPT 的自訂 MCP 外掛（部分介面稱為 App 或連接器）。
Full MCP 透過這個外掛，讓 ChatGPT 呼叫目前 Codex 任務提供的工具；
Simple 則以文字傳遞工具指令，初次使用不需要建立外掛或 Tunnel。

設定順序：**取得 Tunnel → 填入 Bridge → 啟動 Web 模型服務 → 建立並安裝 ChatGPT 外掛 → 在 Codex 驗證**。

### 1. 確認帳號與權限

使用 ChatGPT 網頁版，確認目標帳號／工作區允許新增及使用自訂 MCP 外掛，
並可存取 [OpenAI Platform 的 Tunnel 設定](https://platform.openai.com/settings/organization/tunnels)。
ChatGPT 工作區權限與 Platform 組織的 Tunnel 權限是分開管理的：

| 操作                                      | 所需權限                                   |
| ----------------------------------------- | ------------------------------------------ |
| 檢視 Tunnel                               | Platform 組織的 Tunnels **Read**           |
| 建立或修改 Tunnel                         | Tunnels **Read + Manage**                  |
| 執行 tunnel-client、在外掛設定選取 Tunnel | Tunnels **Read + Use**                     |
| 新增、安裝及使用 ChatGPT 外掛             | 目標 ChatGPT 帳號／工作區允許自訂 MCP 外掛 |

若沒有權限，請由組織／工作區管理員開放；若目前無法使用，先選 **Simple**。
僅有 ChatGPT Pro 訂閱不代表已取得 Tunnel 或工作區權限。
v0.1.94 介面仍顯示較早的 Business／Enterprise／Edu 帳號需求提示；
實際可用性及入口請以你的帳號和 [OpenAI 官方自訂 MCP 文件](https://developers.openai.com/api/docs/guides/custom-mcp-server) 為準。

### 2. 取得 Tunnel、Runtime API key 與官方 client

1. 開啟 [Platform Tunnel 設定](https://platform.openai.com/settings/organization/tunnels)，
   選擇要使用的 Platform 組織，建立或選取 Tunnel。
2. 確認 Tunnel 關聯到要使用的 **ChatGPT 工作區**，以及管理這個 Tunnel 的 Platform 組織。
   個人帳號使用該帳號的個人 Platform 組織；只關聯 Platform 組織，不會自動讓另一個工作區看見 Tunnel。
3. 複製 Tunnel ID。格式為 `tunnel_` 加上 32 個小寫十六進位字元。
4. 請 Platform 組織管理員提供供 `tunnel-client` 使用的 **Runtime API key**，
   確認對所選組織／Tunnel 有 **Read + Use** 權限。這個 key 稍後填入 Bridge，請勿放進 README、Issue 或截圖。
5. 從 Tunnel 設定頁提供的官方下載入口，下載適合你作業系統與 CPU 架構的 `tunnel-client`，
   解壓縮到固定位置。Windows 範例：`C:\Tools\tunnel-client.exe`；macOS／Linux 使用對應的可執行檔並授予執行權限。

Bridge 會管理 client 的啟動與本機 MCP 位址；依照這份教學設定時，不需要另外啟動一個指向相同 Tunnel 的 client。
v0.1.94 使用 client 的 `runtimes connect` 功能；若遇到未知子命令，請更新官方 client，
並以 `tunnel-client runtimes connect --help` 確認該功能可用。
詳細權限、組織關聯與網路需求見 [官方 Secure MCP Tunnel 教學](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 3. 填入 Bridge，讓 Tunnel 就緒

1. 開啟 Bridge，完成「開啟 ChatGPT 登入」與「測試 ChatGPT 連線」。
   登入的帳號與選取的工作區，必須是稍後安裝外掛的帳號／工作區。
2. 在「Codex 工具連線」選擇 **Full MCP — 連接器呼叫工具**，展開「進階 Tunnel 設定」。
3. 填入以下欄位：

   | Bridge 欄位            | 要填什麼                                                            |
   | ---------------------- | ------------------------------------------------------------------- |
   | ChatGPT connector 名稱 | 建議 `CodexGPT Bridge`；必須與稍後建立的外掛名稱完全一致，包括空格  |
   | OpenAI Tunnel ID       | 第 2 步取得的完整 Tunnel ID                                         |
   | OpenAI API key         | 供 tunnel-client 使用的 Runtime API key；已儲存時，不需每次重貼     |
   | tunnel-client 路徑     | 解壓後可執行檔的絕對路徑；Windows 例如 `C:\Tools\tunnel-client.exe` |

4. 按 **「套用」**，再按 **「安裝 Web 模型」** 啟動服務。已安裝模型且服務正在執行時，套用會重新啟動連線。
5. 保持 Bridge 執行，確認出現 **「Tunnel：已就緒」**，再到 ChatGPT 建立外掛。

**第一次只按「套用」，不會啟動尚未安裝的 Web 模型服務。**
因此即使 ID、key 與 client 路徑都已填好，仍可能顯示「Tunnel：尚未就緒」。
先完成「安裝 Web 模型」；若安裝失敗，依畫面錯誤與下方排查表處理。

### 4. 在 ChatGPT 新增並安裝外掛

以下依 [官方新增自訂 MCP server 流程](https://developers.openai.com/api/docs/guides/custom-mcp-server)：

1. 在同一帳號／工作區，到 **Settings → Security and login** 開啟 **Developer mode**，
   再開啟 **[ChatGPT Plugins](https://chatgpt.com/plugins)**。
   此入口依 [OpenAI 官方 Tunnel 連線範例](https://developers.openai.com/cookbook/examples/partners/aws/chatgpt_agents_sdk_aws_agentcore_cookbook/notebooks/chatgpt_agents_sdk_aws_agentcore_cookbook#7-test-the-plugin-connection-in-chatgpt-through-secure-mcp-tunnel)；若沒有開關，請確認工作區政策與帳號可用性。
2. 點選 **「＋」→ Add custom MCP server**。
3. 名稱填入 `CodexGPT Bridge`，或你在 Bridge「ChatGPT connector 名稱」設定的名稱。
4. **Connection 選擇 Tunnel**，選取你的 Tunnel，或貼上相同的 Tunnel ID。
   此連線方式使用 Tunnel ID，無須把本機 `127.0.0.1` 位址貼到 Server URL。
5. Bridge 內建 MCP server 沒有 OAuth 登入流程，驗證方式選擇 **No authentication**。
   Runtime API key 留在 Bridge 的 Tunnel 設定，不填到 ChatGPT 的 OAuth Client Secret。
6. 閱讀權限提示，勾選 **I understand and want to continue**，按 **Create as a plugin**。
7. 在個人外掛或剛才的工作區找到新建外掛，**安裝／啟用**，確認所需工具未被停用。
   建立成功後仍需安裝，才能在對話使用。

若帳號仍使用舊版「Apps／連接器」介面，依該頁顯示的 Developer Mode、建立自訂 App 與啟用流程操作，
同樣使用一致的名稱和 Tunnel ID。若看不到建立入口，先確認帳號／工作區權限。

### 5. 在 Codex 驗證工具呼叫

1. 重新啟動 Codex，選擇 **`CodexGPT Bridge — …`** 模型，保持 Bridge 與 Tunnel 執行。
2. 在一個測試專案開啟新任務，例如要求：「列出目前專案根目錄的檔案名稱，不修改任何檔案。」
3. 確認 Codex 出現實際工具呼叫並收到結果。只有 ChatGPT 文字說「已連線」不能證明工具可用。
4. 若要單獨檢查 ChatGPT 是否已安裝外掛，可在 ChatGPT 的輸入框輸入 `@`，確認可選到同名外掛。
   Bridge 工具需要有效的 Codex 任務上下文，直接在一般聊天呼叫可能回報沒有作用中的任務。

第一次驗證先使用一般聊天與自動送出。需要手動送出時，先套用 Full MCP，再切換互動方式；
使用暫時聊天時，該模式也必須允許 Apps，否則 Bridge 會停止送出。

### 常見設定問題

| 現象                                   | 檢查與處理                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tunnel 尚未就緒，只有按過「套用」      | 按「安裝 Web 模型」啟動服務；保持 Bridge 執行                                                                |
| 安裝模型時回報 client 路徑或子命令錯誤 | 指向實際的 client 可執行檔，使用絕對路徑，確認系統／架構與 `runtimes connect` 功能相容                       |
| key 或 Tunnel 驗證失敗                 | 確認 key 未失效、ID 完整、所屬組織正確，並具 Tunnels Read + Use；填入新 key 後重新套用                       |
| Platform 顯示 Tunnels access required  | 請 Platform 組織管理員授予組織層級的 Tunnel 權限；新角色可能需要最多 30 分鐘生效                             |
| ChatGPT 找不到 Tunnel                  | 確認 Tunnel 關聯到目前 ChatGPT 工作區，且建立外掛的使用者有 Read + Use                                       |
| 建立外掛時無法取得工具                 | 先讓 Bridge 顯示 Tunnel 已就緒，再重新建立或重新整理外掛工具                                                 |
| Tunnel 已就緒，但 Full MCP 工具不可用  | 確認外掛已安裝／啟用、工具未停用、名稱完全一致，且 Bridge 登入相同帳號／工作區；以新的 Codex 任務再測一次    |
| 重啟後連線中斷                         | 保持 Bridge 執行，確認 Web 模型仍已安裝；執行「Doctor」並檢查錯誤。網路需允許 client 對 OpenAI 的 HTTPS 連線 |
| 帳號沒有自訂 MCP／Tunnel 功能          | 先使用 Simple；依官方文件和管理員設定確認可用性                                                              |

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
