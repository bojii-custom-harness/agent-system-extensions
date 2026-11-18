#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${AZURE_CONFIG_DIR+x}" != "x" ]]; then
  if ! selected_config="$(node /usr/local/libexec/azure-project-selector.mjs)"; then
    exit 2
  fi
  export AZURE_CONFIG_DIR="$selected_config"
fi
export AZURE_EXTENSION_DIR="${AZURE_EXTENSION_DIR:-/opt/agent-system/azure-cli/extensions}"
export AZURE_LOGGING_ENABLE_LOG_FILE="${AZURE_LOGGING_ENABLE_LOG_FILE:-false}"
exec /usr/bin/az "$@"
