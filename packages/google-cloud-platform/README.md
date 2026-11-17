# Google Cloud Platform

Project-scoped `gcloud` Extension 套件。`2.0.1` 將登入改接 main OpenCode runtime 與共用設定 volume，保留 Extension 登入介面並移除 `gcloud_cli` Plugin Tool；一般 gcloud 操作改由 shell 執行。舊登入資料不遷移，使用者需重新登入。真實 Google OAuth 由使用者手動驗證，自動測試只驗證合成串接。歷史 `2.0.0` Release 保持不變；精確來源快照見 [`source.json`](source.json)。
