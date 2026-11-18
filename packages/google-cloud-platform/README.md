# Google Cloud Platform

`2.0.4` 將套件安裝與 runtime readiness 分開：缺少 gcloud 時仍可完成套件安裝，狀態與登入入口會明確提示準備 CLI，不再因前置檢查讓宿主安裝交易停在 `outcome-unknown`。`2.0.3` 將 CLI wrapper、專案選擇器、安裝器與 runtime 整合測試完整移入本套件。宿主 image 不預裝 gcloud，請依 [`runtime 安裝說明`](source/runtime/README.md) 安裝。升級清理政策由 manifest metadata 宣告；歷史失敗交易須確認回滾與副作用後再恢復。

宿主整合驗證：設定 `AGENT_SYSTEM_BACKEND_ROOT` 為主 repo 的 `backend` 絕對路徑後執行 `npm run test:gcp-host`；需可執行 Docker Compose CLI，測試僅解析設定，不啟動容器。

Project-scoped `gcloud` Extension 套件。`2.0.2` 使用通用 Extension data volume，GCP 設定位於 `extensions/google-cloud-platform/projects/<project>`，並由 main/workflow-test runtime 共用；保留 Extension 登入介面並移除 `gcloud_cli` Plugin Tool，一般 gcloud 操作改由 shell 執行。舊登入資料不遷移，使用者需重新登入。真實 Google OAuth 由使用者手動驗證，自動測試只驗證合成串接。歷史 `2.0.0`、`2.0.1` Releases 保持不變；精確來源快照見 [`source.json`](source.json)。
