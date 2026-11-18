# Azure DevOps Platform

## 3.0.2：修正 Microsoft 個人帳號 guest 的 TF400813

已確認正確租戶及有效 token 仍可能被官方 SDK 的 `X-VSS-ForceMsaPassThrough: true` 解讀為另一個 MSA 使用者。獨立 runtime image 的固定版本相容性修補關閉此預設，保留 Entra 租戶身分。部署需重新建置 [`runtime/`](runtime/README.md) image；不需刪除登入資料或重新登入。

## 3.0.1：依 Organization 選擇登入租戶

從 Azure DevOps challenge 讀取 `X-VSS-ResourceTenant`，瀏覽器登入指定 `az login --tenant`。已登入其他租戶時，前端顯示租戶不符並允許重新登入，不再只因取得任意租戶 token 就判定登入成功。無法辨識租戶時提供明確錯誤。

Project-scoped Azure DevOps Extension 套件。`2.0.0` 首版依 [`source.json`](source.json) 記錄的 source tree 重建；backend、frontend、Project 設定、Plugin、Tools、Skills 與退役 MCP context migration 均由套件負責。

## 3.0.0：官方 CLI 與瀏覽器 SSO

前端保留 Organization、Project 與 Microsoft Entra SSO。舊工具與專用 Skill 退役，Agent 使用 `azure_devops_cli` 傳入 `az devops` 後的 argv；`invoke` 可使用帳號在該 Organization 的權限。Project 是預設 context，不是權限邊界。

部署前先依 [`runtime/README.md`](runtime/README.md) 建置獨立 CLI image（Azure CLI 2.93.0、azure-devops 1.0.11）。CLI 不依賴 backend／OpenCode image 內的安裝；登入由共用瀏覽器完成，設定保存在 Project 專屬目錄，既有設定與秘密儲存不刪除。

宿主安裝交易會同步 Plugin 到 main 與 workflow-test，兩邊使用同一 Project 設定與 CLI backend。需要支援 backend hooks 及 `retirePreviousPluginContributions` 的宿主。獨立測試使用 `npm test`，Plugin 型別檢查使用 `npm run typecheck:azure-devops`。

以下為 2.x 歷史說明；`policy/` 與舊 `host-tests/` 僅記錄原工具行為，不包含於 3.0.0 封裝。

## 2.0.2：完成來源與政策拆分

- `policy/` 唯一維護原宿主的參數政策、context 驗證與工具 request 解析。
- `backend-module.ts` 將政策與 backend 組合；builder 使用 esbuild 產生自包含的 archive `backend/entry.js`，可由宿主的 data URL loader 載入。
- 套件匯出 `prepareRequest`、`normalizeSettings`、`runtimeContext` 通用 hooks。需搭配支援這些 hooks 的 Agent System 宿主；舊宿主仍可使用既有工具路徑。
- 主 repo 舊有 Azure DevOps 測試完整移至 `host-tests/`；GitLab 對應測試移至該套件 `host-tests/`，以既有外部版本為準更新預期。

在此 repo 執行跨 repo 整合驗證：

```powershell
$env:AGENT_SYSTEM_BACKEND_ROOT = "C:\path\agent-system\backend"
npm run test:host
```

需先安裝兩個 repo 的 npm 相依套件，並準備宿主既有 Default Workflow build assets。
Runner 在暫存目錄組裝實際候選 archive 內容，連接指定宿主的 source，保留原有案例的相對路徑，
測試後清除。產品程式與 `.aicxt` 不依賴該測試路徑；`npm test` 的獨立套件測試不需宿主。

## 2.0.1：使用者手動安裝 Azure CLI

Azure CLI 固定版本及手動安裝入口改由本擴充套件管理，位於 [`source/runtime/`](source/runtime/README.md)，並隨 `.aicxt` 發布。套件安裝或啟動不會自動下載 Azure CLI；使用者依說明自行下載並執行腳本。

可下載此版本的安裝腳本與版本檔：

- [install-azure-cli-runtime.sh](https://raw.githubusercontent.com/bojii-custom-harness/agent-system-extensions/azure-devops-platform-2.0.1/packages/azure-devops-platform/source/runtime/install-azure-cli-runtime.sh)
- [azure-cli-versions.env](https://raw.githubusercontent.com/bojii-custom-harness/agent-system-extensions/azure-devops-platform-2.0.1/packages/azure-devops-platform/source/runtime/azure-cli-versions.env)

兩個檔案放在同一目錄後，依 runtime README 在實際需要 CLI 的環境手動安裝。
