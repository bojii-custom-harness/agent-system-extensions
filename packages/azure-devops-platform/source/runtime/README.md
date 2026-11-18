# Project shell 的 Azure CLI

將**整個本目錄**複製到 main 與 workflow-test 的 Debian bookworm 容器，分別以 root 執行：

```sh
sh ./install-azure-cli-runtime.sh
```

安裝器提供 Azure CLI 2.93.0、官方 azure-devops 1.0.11、Entra guest SDK 相容性修補及 `/usr/local/bin/az` 入口。可重複執行，不會刪除既有 Project 登入資料。流程與 gcloud 的外部套件手動安裝一致；容器重新建立後需重新執行安裝器，或在部署自有衍生 image 的建置中執行同一入口。

## 直接使用

```sh
cd /workspace/projects/123
az devops project list --detect false
az repos list --detect false
az boards work-item show --id 2938
```

workflow-test 使用 `/workflow/projects/123`。Project 子目錄也會自動對應到：

```text
/var/lib/agent-system/extensions/azure-devops-platform/projects/123/.azure
```

兩個 runtime 已掛載共用資料，因此沿用前端 SSO 的登入狀態，不需重登。前端儲存 Organization／Project 時，透過官方 `az devops configure` 同步共用的 CLI 預設值；命令仍可明確覆寫。`az` 的所有命令群組皆可用，不再受原 `azure_devops_cli` 工具的 argv 限制。

不在 managed Project 目錄時，需明確設定非空、絕對路徑的 `AZURE_CONFIG_DIR`。Wrapper 自動設定 `AZURE_EXTENSION_DIR`；請勿將部署級 `AZURE_CONFIG_DIR` 固定為某個 Project。

Project selector 只是預設值選擇，不提供 shell 程序間的憑證存取隔離。具 shell 權限的 Agent 可依既有系統權限使用 CLI 與資料。
