#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
versions_file=${1:-"$script_dir/azure-cli-versions.env"}
. "$versions_file"

: "${AZURE_CLI_VERSION:?AZURE_CLI_VERSION is required}"
: "${AZURE_DEVOPS_EXTENSION_VERSION:?AZURE_DEVOPS_EXTENSION_VERSION is required}"

export AZURE_EXTENSION_DIR="${AZURE_EXTENSION_DIR:-/opt/agent-system/azure-cli/extensions}"
export AZURE_LOGGING_ENABLE_LOG_FILE=false
test "$(id -u)" = 0 || { echo "請以 root 執行安裝。" >&2; exit 1; }
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg
install -d -m 0755 "$AZURE_EXTENSION_DIR"

. /etc/os-release
if [ "${VERSION_CODENAME:-}" != "bookworm" ]; then
  printf 'Azure CLI runtime install only supports the pinned Debian bookworm base (got %s).\n' "${VERSION_CODENAME:-unknown}" >&2
  exit 1
fi

install -d -m 0755 /etc/apt/keyrings
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output /tmp/microsoft.asc \
  https://packages.microsoft.com/keys/microsoft.asc
gpg --dearmor --batch --yes --output /etc/apt/keyrings/microsoft.gpg /tmp/microsoft.asc
chmod 0644 /etc/apt/keyrings/microsoft.gpg
rm -f /tmp/microsoft.asc

cat > /etc/apt/sources.list.d/azure-cli.sources <<EOF
Types: deb
URIs: https://packages.microsoft.com/repos/azure-cli/
Suites: bookworm
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/microsoft.gpg
EOF

apt-get update
apt-get install -y --no-install-recommends "azure-cli=${AZURE_CLI_VERSION}-1~bookworm"

installed_cli_version=$(/usr/bin/az version --query '"azure-cli"' --output tsv --only-show-errors)
if [ "$installed_cli_version" != "$AZURE_CLI_VERSION" ]; then
  printf 'Expected Azure CLI %s, got %s.\n' "$AZURE_CLI_VERSION" "$installed_cli_version" >&2
  exit 1
fi
/usr/bin/az --version

/usr/bin/az extension add --name azure-devops --version "$AZURE_DEVOPS_EXTENSION_VERSION" --yes --only-show-errors
installed_extension_version=$(/usr/bin/az extension show --name azure-devops --query version --output tsv --only-show-errors)
if [ "$installed_extension_version" != "$AZURE_DEVOPS_EXTENSION_VERSION" ]; then
  printf 'Expected azure-devops extension %s, got %s.\n' "$AZURE_DEVOPS_EXTENSION_VERSION" "$installed_extension_version" >&2
  exit 1
fi

/opt/az/bin/python3 "$script_dir/patch-entra-auth.py"
/usr/bin/az devops --help >/dev/null
login_help=$(/usr/bin/az login --help)
printf '%s\n' "$login_help" | grep -F -- '--allow-no-subscriptions' >/dev/null

rm -rf /var/lib/apt/lists/*
install -d -m 0755 /usr/local/libexec
install -m 0644 "$script_dir/azure-project-selector.mjs" /usr/local/libexec/azure-project-selector.mjs
install -m 0755 "$script_dir/az-wrapper.sh" /usr/local/bin/az
