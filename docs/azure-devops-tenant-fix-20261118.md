# Azure DevOps TF400813 修復

## 根因

使用者瀏覽器可存取 Organization，但 3.0.0 的 `az login --allow-no-subscriptions` 未指定租戶。現場唯讀比對 Azure CLI profile 與 Azure DevOps projects endpoint 的 `X-VSS-ResourceTenant`，確認登入租戶與 Organization 租戶不同。

## 修改

- 以無憑證請求讀取 Organization 的租戶 challenge；不跟隨登入重新導向、不輸出權杖，租戶 GUID 驗證後短期快取。
- 登入命令指定該租戶；status 比對目前 CLI account 租戶，token 檢查也指定該租戶。
- 前端將「租戶不符」與「未登入」分開，允許直接重新登入。
- 3.0.1 新封裝保留 3.0.0 歷史資產。

## 驗證

- 新增實際 handler 回歸：錯誤租戶不可被判為已登入，重新登入 argv 包含正確 `--tenant`。
- Discovery 回歸：僅使用 Azure DevOps header、拒絕缺失租戶、不傳 token、不跟隨 redirect。
- 現場已取得 Organization 的有效租戶 challenge；後續執行診斷時使用者 profile 已變為空帳號，實際 status 正確回報 `idle`。
- Microsoft 瀏覽器互動須由使用者以有 Organization 權限的帳號重新登入；修復前的瀏覽器授權不能作為修復後 CLI 操作通過證據。
