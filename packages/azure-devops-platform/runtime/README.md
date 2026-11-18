# Azure DevOps CLI Runtime

此 image 僅供 Azure DevOps Platform Extension 建立一次性 CLI 容器使用；不安裝到 Agent System backend 或 OpenCode runtime image。

在 Docker 主機上，從此目錄建置固定版本的本機 image：

```sh
docker build --tag agent-system-extensions/azure-devops-cli-runtime:local .
```

`azure-cli-versions.env` 固定 Azure CLI 與官方 `azure-devops` Extension 版本。建置程序會從 Microsoft 套件來源安裝並驗證版本及 `az devops` 命令群組。

Extension 透過 Docker socket 建立受限的一次性容器，將 Project 專屬 Azure CLI 設定存於共用 Extension data volume。Microsoft Entra 登入狀態不會寫入此 image。`az devops invoke` 與其他 CLI 命令共用登入帳號權限；Organization／Project 是預設 context，不是權限邊界。

登入完成前置條件：Agent System browser remote 可用，且 CLI login container 能透過 OpenCode runtime 的 network namespace 存取 localhost callback。SSO 必須在實際環境以人工 Microsoft 登入流程驗收。
