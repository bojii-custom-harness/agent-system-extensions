# Azure DevOps Platform

Project-scoped Azure DevOps Extension 套件。`2.0.0` 首版依 [`source.json`](source.json) 記錄的 source tree 重建；backend、frontend、Project 設定、Plugin、Tools、Skills 與退役 MCP context migration 均由套件負責。

Backend 會先驗證 PAT，再保存至受保護的 Extension secret store。Runtime Project identity 由 Agent System host 提供，不從未信任的 Tool input 推導。

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
