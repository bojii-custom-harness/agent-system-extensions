FROM node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/bojii-custom-harness/agent-system-extensions"

ENV AZURE_EXTENSION_DIR=/opt/agent-system/azure-cli/extensions

COPY azure-cli-versions.env /usr/local/share/azure-devops-cli-runtime/azure-cli-versions.env
COPY install-azure-cli-runtime.sh /usr/local/bin/install-azure-cli-runtime.sh
COPY azure-devops-browser-remote.mjs /usr/local/bin/azure-devops-browser-remote

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && chmod 0755 /usr/local/bin/install-azure-cli-runtime.sh /usr/local/bin/azure-devops-browser-remote \
    && /usr/local/bin/install-azure-cli-runtime.sh \
    && rm -f /usr/local/bin/install-azure-cli-runtime.sh

COPY patch-entra-auth.py /usr/local/share/azure-devops-cli-runtime/patch-entra-auth.py
RUN /opt/az/bin/python3 /usr/local/share/azure-devops-cli-runtime/patch-entra-auth.py

ENTRYPOINT ["/usr/bin/az"]
