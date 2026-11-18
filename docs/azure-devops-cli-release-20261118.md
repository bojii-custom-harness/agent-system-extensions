# Azure DevOps CLI 3.0.0 驗證

## 修復原因

- 原始碼已修改但仍比較舊封裝，`deepEqual(Buffer, Buffer)` 失敗時展開大量差異，造成記憶體／字串長度錯誤。改為 `Buffer.equals` 與有界錯誤訊息；新建 3.0.0 封裝，保留已發布 2.x。
- 修正前端 template literal 與缺少 `activate(host).editor.mount`；Plugin 補齊 `basename` import，型別檢查改為涵蓋實際 Plugin。
- Docker 保留共用 volume 的 `extensions` subpath、直接解碼日誌 Buffer、使用支援 subpath 的 API，並關閉單一 local log 檔不支援的壓縮。
- `invoke` 不接受通用 `--project`，改用官方 Extension 1.0.11 實測有效的 `AZURE_DEVOPS_EXT__DEFAULTS_PROJECT`；認證、CLI 設定由 backend 管理。

## 實際結果

- Node 24：`npm run typecheck:azure-devops` 通過。
- `npm test`：68 + 20 案例通過；`npm run extensions:verify`：5 套封裝通過。
- Docker 獨立 runtime image 建置通過，Azure CLI 2.93.0／azure-devops 1.0.11；真實 Python config 讀取 Project 環境預設通過。
- 從運行中的 backend 呼叫實際 handler，以隔離 smoke Project 執行 `az devops project list --help`：Docker API、容器啟動、volume subpath、argv、輸出與清理通過。未發送真實 Azure 業務操作。
- 本機 Project `123` 安裝交易完成，`pluginRuntimeReadiness.requiredTargets` 與 `verifiedTargets` 均為 `main`、`workflow-test`，兩者 `verified`。安裝 checkpoint 的 SHA-256 與候選封裝一致。
- Docker 引擎先前 500／逾時，重啟 Docker Desktop 後 BFF、main、workflow-test、browser-remote 健康。

## 尚需使用者完成

Project `123` 尚未設定 Organization；Microsoft Entra 真人瀏覽器登入與登入後 Azure 操作未驗收。請先於 Extension 儲存 Organization，再完成 SSO 並選擇 Project。
