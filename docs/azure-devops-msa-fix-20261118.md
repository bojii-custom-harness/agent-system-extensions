# TF400813：官方 SDK 強制 MSA 身分的相容性修復

## 實際根因

3.0.1 已成功將 CLI 登入租戶修正為 Organization 租戶，但仍回報相同 TF400813。比對實際認證與 HTTP 呼叫：

- CLI profile、token `tid` 與 Organization 租戶一致，token audience 正確；沒有使用 PAT，azuredevops 磁碟 cache 為空。
- 相同 token 直接呼叫 projects API，Bearer 與 Basic 都回傳 200、174 個 Projects。
- 官方 CLI 實際送出的 token 與前述一致，但 SDK 預設加入 `X-VSS-ForceMsaPassThrough: true`。
- 單變量對照：相同 endpoint、token，該 header 為 true 時重現 401 與原 TF400813 使用者 ID；false 時回傳 200、174 個 Projects。
- token 的 `idp` 是 `live.com`；SDK 強制 MSA 路徑與 Entra guest 路徑被服務解析成不同的 Azure DevOps 使用者。租戶修正必要但不足，先前結論不能代表完整修復。

## 修改與防線

`runtime/patch-entra-auth.py` 在固定 azure-devops 1.0.11 的 SDK `Client` 中，將 `_force_msa_pass_through` 預設改為 false。只影響本 Extension 的獨立 CLI image；仍由官方 CLI 執行命令及取得 token，不引入自訂 REST 工具或 PAT。

建置時要求原設定恰好出現一次，SDK 結構變動即失敗；修補後載入實際 `Client` 並斷言設定為 false。`Dockerfile` 在原 CLI 安裝完成後執行這個檢查。

## 現場驗證

- `docker build -t agent-system-extensions/azure-devops-cli-runtime:local packages/azure-devops-platform/runtime` 通過，輸出 `Azure DevOps SDK Entra guest identity: OK`。
- 保留既有登入，不新增授權或更動 Organization 成員。
- 經 Project `123` 的實際 Extension `/backend/projects` 呼叫：HTTP 200，174 個 Projects，包含使用者要求的 `agent-system`。
- 診斷只輸出必要身分欄位、HTTP status 與數量，未輸出 token、Authorization header 或 Projects 內容。
