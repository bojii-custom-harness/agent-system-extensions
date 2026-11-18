#!/bin/sh
set -eu

# 僅由使用者明確執行；套件安裝與宿主 image 不會自動呼叫。
test "$(id -u)" = 0 || { echo "請以 root 執行安裝。" >&2; exit 1; }
runtime_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg
install -d -m 0755 /usr/share/keyrings /usr/local/libexec
key_file="$(mktemp)"
trap 'rm -f "$key_file"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://packages.cloud.google.com/apt/doc/apt-key.gpg --output "$key_file"
gpg --dearmor --batch --yes --output /usr/share/keyrings/cloud.google.gpg "$key_file"
chmod 0644 /usr/share/keyrings/cloud.google.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' \
  > /etc/apt/sources.list.d/google-cloud-sdk.list
apt-get update
apt-get install -y --no-install-recommends google-cloud-cli=558.0.0-0
/usr/lib/google-cloud-sdk/bin/gcloud version | grep -Fq 'Google Cloud SDK 558.0.0'
install -m 0644 "$runtime_dir/gcloud-project-selector.mjs" /usr/local/libexec/gcloud-project-selector.mjs
install -m 0755 "$runtime_dir/gcloud-wrapper.sh" /usr/local/bin/gcloud
