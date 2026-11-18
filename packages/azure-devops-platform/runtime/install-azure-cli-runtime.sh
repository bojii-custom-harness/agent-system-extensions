#!/bin/sh
set -eu

versions_file=${1:-/usr/local/share/azure-devops-cli-runtime/azure-cli-versions.env}
. "$versions_file"

: "${AZURE_CLI_VERSION:?AZURE_CLI_VERSION is required}"
: "${AZURE_DEVOPS_EXTENSION_VERSION:?AZURE_DEVOPS_EXTENSION_VERSION is required}"

export AZURE_EXTENSION_DIR=/opt/agent-system/azure-cli/extensions
install -d -m 0755 "$AZURE_EXTENSION_DIR"

. /etc/os-release
if [ "${VERSION_CODENAME:-}" != "bookworm" ]; then
  printf 'Azure CLI runtime install only supports Debian bookworm (got %s).\n' "${VERSION_CODENAME:-unknown}" >&2
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

installed_cli_version=$(az version --query '"azure-cli"' --output tsv --only-show-errors)
test "$installed_cli_version" = "$AZURE_CLI_VERSION"
az extension add --name azure-devops --version "$AZURE_DEVOPS_EXTENSION_VERSION" --yes --only-show-errors
installed_extension_version=$(az extension show --name azure-devops --query version --output tsv --only-show-errors)
test "$installed_extension_version" = "$AZURE_DEVOPS_EXTENSION_VERSION"
az devops --help >/dev/null
login_help=$(az login --help)
printf '%s\n' "$login_help" | grep -F -- '--allow-no-subscriptions' >/dev/null

rm -rf /var/lib/apt/lists/*
