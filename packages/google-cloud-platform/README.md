# Google Cloud Platform

Project-scoped `gcloud` Extension 套件。`2.0.2` 使用通用 Extension data volume，GCP 設定位於 `extensions/google-cloud-platform/projects/<project>`，並由 main/workflow-test runtime 共用；保留 Extension 登入介面並移除 `gcloud_cli` Plugin Tool，一般 gcloud 操作改由 shell 執行。舊登入資料不遷移，使用者需重新登入。真實 Google OAuth 由使用者手動驗證，自動測試只驗證合成串接。歷史 `2.0.0`、`2.0.1` Releases 保持不變；精確來源快照見 [`source.json`](source.json)。
