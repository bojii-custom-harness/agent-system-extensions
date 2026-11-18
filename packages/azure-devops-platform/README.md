# Azure DevOps Platform

Project-scoped Azure DevOps Extension 套件。`2.0.0` 首版依 [`source.json`](source.json) 記錄的 source tree 重建；backend、frontend、Project 設定、Plugin、Tools、Skills 與退役 MCP context migration 均由套件負責。

Backend 會先驗證 PAT，再保存至受保護的 Extension secret store。Runtime Project identity 由 Agent System host 提供，不從未信任的 Tool input 推導。

## 2.0.1：使用者手動安裝 Azure CLI

Azure CLI 固定版本及手動安裝入口改由本擴充套件管理，位於 [`source/runtime/`](source/runtime/README.md)，並隨 `.aicxt` 發布。套件安裝或啟動不會自動下載 Azure CLI；使用者依說明自行下載並執行腳本。

可下載此版本的安裝腳本與版本檔：

- [install-azure-cli-runtime.sh](https://raw.githubusercontent.com/bojii-custom-harness/agent-system-extensions/azure-devops-platform-2.0.1/packages/azure-devops-platform/source/runtime/install-azure-cli-runtime.sh)
- [azure-cli-versions.env](https://raw.githubusercontent.com/bojii-custom-harness/agent-system-extensions/azure-devops-platform-2.0.1/packages/azure-devops-platform/source/runtime/azure-cli-versions.env)

兩個檔案放在同一目錄後，依 runtime README 在實際需要 CLI 的環境手動安裝。
