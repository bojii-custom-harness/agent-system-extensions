#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${CLOUDSDK_CONFIG+x}" != "x" ]]; then
  if ! selected_config="$(node /usr/local/libexec/gcloud-project-selector.mjs)"; then
    exit 2
  fi
  export CLOUDSDK_CONFIG="$selected_config"
fi

exec /usr/lib/google-cloud-sdk/bin/gcloud "$@"
