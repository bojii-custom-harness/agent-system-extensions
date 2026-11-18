# Azure DevOps 4.0.0：直接 shell 驗證

使用者要求 Azure CLI 與 gcloud 一樣可由 main、workflow-test shell 直接呼叫，不再經單一 Agent tool。

## 實作

- 將 Project selector、`az` shell wrapper、固定版本 installer 與 MSA SDK patch 放在發布封裝的 `runtime/`。依現有 gcloud 流程，部署管理者明確在兩個 runtime 安裝。
- 從 managed Project 工作目錄及子目錄選用共用 `.azure` profile，保留顯式 `AZURE_CONFIG_DIR`。selector 是預設選擇而非權限隔離。
- 前端儲存設定呼叫 `configure`，以官方 CLI 將 Organization／Project 寫入共用 defaults。清空 Project 時移除舊預設。
- 套件不再宣告 Plugin／Tool，舊 `run-cli` 路徑回傳 404；manifest 保留退役政策，前端 SSO 沿用既有登入。

## 實測

- main 與 workflow-test installer 均成功：Azure CLI 2.93.0、azure-devops 1.0.11、實際 SDK MSA 相容性檢查通過。
- 從 `/workspace/projects/123` 與 `/workflow/projects/123` 原生執行 `az devops project list`，均取得 174 個 Projects，不需重新登入或手動傳入認證環境。
- main 使用前端既有預設執行 `az repos list --detect false --query 'length(@)'`：4。
- workflow-test 執行 `az boards work-item show --id 2938 --query id`：2938。
- 4.0.0 安裝交易 completed，manifest resources 空；兩個 runtime 原 `.opencode/plugins/azure-devops-platform.ts` 均不存在。
- 單元回歸涵蓋 main/workflow 子目錄、顯式設定、Project 外目錄拒絕、符號連結、共用 defaults 寫入／清除、舊工具入口退役。

## 部署責任

原生 CLI binary 依現有 gcloud 手動安裝契約安裝於容器；重建容器需重跑套件 installer，或在部署自有 image 建置時執行。登入資料位於既有持久化 volume，與 binary 生命週期分開。
