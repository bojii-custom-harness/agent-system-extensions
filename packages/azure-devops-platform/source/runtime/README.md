# 手動安裝 Azure CLI

Azure CLI 與官方 `azure-devops` CLI extension 的版本及安裝入口由本擴充套件管理。Agent System 的 backend／OpenCode image 不再下載或預裝它們；使用者需要時自行下載及執行安裝。

## Debian bookworm 容器

將本目錄的 `install-azure-cli-runtime.sh` 與 `azure-cli-versions.env` 一起下載或複製至需要使用 Azure CLI 的容器，以 root 執行：

```sh
sh ./install-azure-cli-runtime.sh
```

此命令會從 Microsoft 官方來源下載 Azure CLI `2.93.0` 及官方 `azure-devops` extension `1.0.11`，核對版本並檢查命令可用性。需要 `curl`、`gnupg`、`ca-certificates`；目前 backend／OpenCode image 已包含這些工具。安裝不會登入帳號。

請在使用 Azure CLI 的程序環境設定：

```sh
export AZURE_EXTENSION_DIR=/opt/agent-system/azure-cli/extensions
export AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no
```

以 Compose 啟動時，請將這兩項設定加入需要 CLI 的 service `environment`，讓服務程序也取得相同設定。backend、OpenCode main 與 workflow-test 是不同容器，需要分別安裝；僅在主機安裝不會提供給容器使用。容器重新建立後需重新安裝，或由使用者自行維護已安裝的衍生 image。

`AZURE_CONFIG_DIR` 仍由各 Project 的登入流程指定，不應設為部署共用的登入目錄。

## 其他作業系統

依 [Microsoft 官方安裝文件](https://learn.microsoft.com/cli/azure/install-azure-cli) 自行下載 Azure CLI，再手動執行：

```sh
az extension add --name azure-devops --version 1.0.11
az version
az extension show --name azure-devops
```

請使用上述 `AZURE_EXTENSION_DIR` 設定（其他作業系統可自行指定可寫入的絕對路徑），並在安裝與實際服務程序中使用相同路徑。
