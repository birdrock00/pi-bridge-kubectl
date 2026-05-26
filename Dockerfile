# syntax=docker/dockerfile:1.7

FROM docker.io/bitnami/kubectl:latest AS kubectl

FROM node:22-bookworm-slim AS runtime

ARG PI_VERSION=v0.74.0
ARG PI_LINUX_X64_SHA256=d67657a30d49c9faca80868d2a4bdba4dfcac04702893f45a6d14b249345eb8d

ENV PORT=5000 \
    PI_ENV_FILE=/secrets/pi/.env \
    PI_SESSION_BASE_DIR=/data/pi/sessions \
    WORKSPACE_DIR=/workspace/rpi \
    HOME=/root \
    PI_CODING_AGENT_DIR=/data/pi/agent \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ansible \
      bash \
      ca-certificates \
      curl \
      git \
      tini \
      wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=kubectl /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl
COPY package.json /app/package.json
COPY matrix-bot.js /app/matrix-bot.js

RUN set -eux; \
    chmod +x /usr/local/bin/kubectl; \
    ansible-playbook --version; \
    ansible-vault --version; \
    curl -fsSL "https://github.com/earendil-works/pi/releases/download/${PI_VERSION}/pi-linux-x64.tar.gz" -o /tmp/pi-linux-x64.tar.gz; \
    echo "${PI_LINUX_X64_SHA256}  /tmp/pi-linux-x64.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/pi; \
    tar -xzf /tmp/pi-linux-x64.tar.gz -C /opt/pi --strip-components=1; \
    chmod +x /opt/pi/pi; \
    ln -s /opt/pi/pi /usr/local/bin/pi; \
    rm -f /tmp/pi-linux-x64.tar.gz; \
    pi --version; \
    mkdir -p /workspace /data/pi/sessions /data/pi/agent

COPY <<'EOF' /usr/local/bin/start-pi-bridge
#!/bin/sh
set -eu

log() {
  echo "[STARTUP] $*"
}

if [ -f "$PI_ENV_FILE" ]; then
  log "Loading environment from $PI_ENV_FILE"
  set -a
  . "$PI_ENV_FILE"
  set +a
else
  log "No env file found at $PI_ENV_FILE; continuing with Kubernetes environment"
fi

mkdir -p "$(dirname "$WORKSPACE_DIR")" "$PI_SESSION_BASE_DIR" "$PI_CODING_AGENT_DIR"

if [ -n "${GIT_REPO_URL:-}" ]; then
  log "Refreshing git checkout from $GIT_REPO_URL"
  rm -rf "$WORKSPACE_DIR"
  git clone --depth "${GIT_CLONE_DEPTH:-1}" "$GIT_REPO_URL" "$WORKSPACE_DIR"
fi

if [ -d "$WORKSPACE_DIR/.git" ]; then
  cd "$WORKSPACE_DIR"
  git rev-parse --short HEAD 2>/dev/null | sed 's/^/[STARTUP] workspace checkout: /'
else
  log "Workspace checkout not present at $WORKSPACE_DIR"
  cd /app
fi

log "Starting Pi Matrix bridge on port ${PORT}"
exec node /app/matrix-bot.js
EOF

RUN chmod +x /usr/local/bin/start-pi-bridge

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["start-pi-bridge"]
