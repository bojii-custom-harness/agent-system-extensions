# 使用者安裝 Google Cloud CLI

宿主 image 與擴充套件安裝流程不會下載 CLI。請使用者先將此 runtime 目錄複製到需要執行 gcloud 的 OpenCode 容器，再以 root 執行：

```sh
sh /path/to/runtime/install-gcloud.sh
```

適用 Debian／Ubuntu，安裝官方 Google Cloud CLI 558.0.0 與專案設定選擇器；需要網路、apt、Node.js。
main 與 workflow-test 容器須分別安裝。容器重建後須重新執行，或由使用者自行製作衍生 image。
`CLOUDSDK_CONFIG` 明確設定時優先使用；否則由工作目錄選擇共享 Extension data volume 中的專案設定。
