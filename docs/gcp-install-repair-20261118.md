# GCP 2.0.4 安裝修復與本機驗證

## 原因與修正

2.0.3 的 install lifecycle 執行 runtime preflight，但宿主 image 與套件安裝不會準備 CLI。main runtime 缺少 gcloud，Docker exec 失敗後被轉為 `GCP_RUNTIME_COMMAND_FAILED`；宿主回滾套件，保留 `outcome-unknown` checkpoint，後續操作被拒絕。

2.0.4 的 install lifecycle 僅完成套件安裝，不呼叫 Docker 或改動 runtime。狀態、登入與舊資源清理仍須通過 runtime preflight。版本檢查透過 shell 確認命令存在並保留非零退出碼，缺少 CLI 時提供安裝指引，不再被通用命令錯誤遮蔽。新增回歸涵蓋缺少 CLI、重播安裝、準備依賴後狀態恢復與 UI 指引。

## 2026-11-18 本機修復

- main 與 workflow-test 以套件 `runtime/install-gcloud.sh` 安裝固定 CLI 558.0.0，兩者成功。
- 僅處理 `test-google` 的 GCP 2.0.3 失敗 checkpoint：核對精確 hash、錯誤分類、套件已回滾為未安裝及原 lifecycle 在缺少執行檔時尚未建立 Project 設定。備份原 checkpoint 後將階段恢復為 `resolved`，未變更其他 Project 的作業。
- 備份位於 backend 持久化資料的 `install-operations/5f3242f0540ec2a8c6710fbb4c7edf83e2b9af81f7eae1d59d7561b0313b4f37.json.before-gcp-repair-20261118`。
- 透過真實 multipart 安裝 API 安裝本機 2.0.4，回傳 `installed: true` 與 `operation.stage: completed`。
- 真實 `test-google` backend status 回傳 `{"authenticated":false,"login":"idle","project":"test-google","state":"ready"}`。
- 本機 archive SHA-256：`ef88b5b201566ca4b608a2d22aaca407c63b9d8de39fd2137ad32f71b4de0d6e`。

這是已核對本次失敗邊界後的一次性恢復，不是允許任意重播未知 lifecycle。未覆寫既有 2.0.3 Release、未更新公開 catalog，2.0.4 尚未發布。Google OAuth 仍由使用者登入；本次未操作帳戶授權。

## 驗證

- `npm test`：66 項通過，接續顯式 GCP 集合 20 項通過。
- `npm run test:gcp-ui`：14 項通過，包含缺少 CLI 的新 UI 回歸。
- `npm run test:gcp-host`：設定 `AGENT_SYSTEM_BACKEND_ROOT` 指向 agent-system/backend，19 項通過。
- `npm run extensions:verify`：5 套 artifact 可重現驗證通過。
- `git diff --check`：通過。

首次全套檢查發現共用 artifact 測試仍指定 2.0.3，更新候選版本後通過。首次 UI 驗證缺少 Playwright Chromium，安裝相符版本後通過。

## runtime 重建

CLI 現已安裝於兩個正在運行的容器。依現有 runtime 契約，容器重建後須重新執行套件安裝腳本，或由部署者製作衍生 image；此次沒有將套件專屬依賴重新嵌入宿主 image。套件安裝狀態及 Project 設定位於持久化資料。
