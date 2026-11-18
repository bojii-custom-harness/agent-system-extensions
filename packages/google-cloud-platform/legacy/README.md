# 舊版 OAuth 實作封存

此目錄承接主 repo 的舊版 Google OAuth 回呼原始碼，保留遷移紀錄，不參與建置或發布。
現行套件使用 gcloud 與 browser-remote 的 loopback 登入；不再註冊 `/oauth/google/callback` 與固定 BFF 回呼路由。
舊碼中的宿主相對 import 僅作歷史參考。
