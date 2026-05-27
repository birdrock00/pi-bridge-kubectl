# pi-bridge-kubectl

Matrix chat bridge that responds to `!pi` by running the Pi coding agent in a
container that also includes `kubectl`, `git`, and `ansible`.

The image installs:

- Pi `v0.74.0` from `earendil-works/pi` using a pinned release archive and
  SHA-256 digest.
- `kubectl` from the Bitnami kubectl image.
- The Matrix sync connector in `matrix-bot.js`.

Give the container only the Kubernetes credentials and repository access that
its Matrix users are authorized to invoke.

All hostnames, users, room IDs, repositories, and credentials in this document
are intentionally fabricated examples. Do not use them as credentials.

## Container Image

GitHub Actions publishes images to GHCR on changes to `main`:

```text
ghcr.io/birdrock00/pi-bridge-kubectl:latest
```

## Required Inputs

The Matrix bridge requires:

- `MATRIX_HOMESERVER`
- Either `MATRIX_ACCESS_TOKEN`, or both `MATRIX_USER_ID` and
  `MATRIX_PASSWORD`
- Credentials for the model provider configured for Pi, supplied using the
  environment names required by that provider

Restrict the bot with `MATRIX_ROOM_ID` or `MATRIX_ALLOWED_ROOMS` unless it is
intended to accept requests from every Matrix room it joins.

## Environment Variables

### Matrix Connector

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MATRIX_HOMESERVER` | Yes | Empty | Matrix client-server base URL. |
| `MATRIX_ACCESS_TOKEN` | Conditional | Empty | Existing bot access token. When set, password login is skipped. |
| `MATRIX_USER_ID` | Conditional | Empty | Bot Matrix user ID; required with `MATRIX_PASSWORD` if no access token is provided. |
| `MATRIX_PASSWORD` | Conditional | Empty | Bot password for Matrix login if no access token is provided. |
| `MATRIX_DEVICE_ID` | No | `PI_BRIDGE_001` | Device ID used during password login. |
| `MATRIX_BOT_NAME` | No | `pi` | Device display name used during password login. |
| `MATRIX_TRIGGER` | No | `!pi` | Message prefix that invokes the bot. |
| `MATRIX_ROOM_ID` | No | Empty | Comma-separated room allowlist; takes precedence over `MATRIX_ALLOWED_ROOMS`. Empty allows all joined rooms. |
| `MATRIX_ALLOWED_ROOMS` | No | Empty | Comma-separated room allowlist used when `MATRIX_ROOM_ID` is empty. |
| `MATRIX_SYNC_TIMEOUT_MS` | No | `30000` | Matrix long-poll sync timeout in milliseconds. |
| `MATRIX_PROGRESS_INTERVAL_MS` | No | `60000` | Frequency of elapsed-time status updates in milliseconds. |
| `MATRIX_IGNORE_INITIAL_SYNC` | No | `false` | Set to `true`, `yes`, `on`, or `1` to avoid handling timeline items returned by the first sync after startup. |
| `PORT` | No | `5000` | Port for the `/health` HTTP endpoint. |

### Pi Agent And Output

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PI_MODEL` | No | `CHAT_MODEL`, then `DEFAULT_MODEL`, then Pi default | Model argument passed to Pi. |
| `CHAT_MODEL` | No | Empty | Fallback model if `PI_MODEL` is empty. |
| `DEFAULT_MODEL` | No | Empty | Final configured fallback model if `PI_MODEL` and `CHAT_MODEL` are empty. |
| `PI_PROVIDER` | No | Empty | Provider argument passed to Pi. |
| `PI_THINKING` | No | Empty | Thinking setting passed to Pi. |
| `PI_TOOLS` | No | Empty | Tools selection passed to Pi. |
| `PI_EXTRA_ARGS` | No | Empty | Additional Pi CLI arguments, as a JSON string array or whitespace-separated values. |
| `PI_REQUEST_TIMEOUT_MS` | No | `900000` | Maximum duration of one Matrix-requested Pi run in milliseconds. |
| `PI_MAX_OUTPUT_BYTES` | No | `180000` | Maximum buffered stdout/stderr data retained during a request. |
| `PI_PROGRESS_PUBLISH_INTERVAL_MS` | No | `3000` | Minimum interval between live output posts to Matrix in milliseconds. |
| `PI_SESSION_BASE_DIR` | No | `/data/pi/sessions` | Location for per-request Pi session directories. Mount persistent storage here if sessions must survive pod replacement. |
| `PI_CODING_AGENT_DIR` | No | `/data/pi/agent` | Container-created Pi agent data directory. |

Provider credentials are pass-through values consumed by Pi or the selected
provider. For example, a provider may require `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `GEMINI_API_KEY`; use the documentation for the selected
Pi provider and keep those values in secrets.

### Container Startup And Workspace

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PI_ENV_FILE` | No | `/secrets/pi/.env` | Optional shell-format env file sourced by the entrypoint before startup. |
| `WORKSPACE_DIR` | No | `/workspace/rpi` | Working directory in which Pi commands run. Set this to your mounted or cloned project directory. |
| `GIT_REPO_URL` | No | Empty | Git repository cloned into `WORKSPACE_DIR` on every container start. |
| `GIT_CLONE_DEPTH` | No | `1` | Clone depth when `GIT_REPO_URL` is set. |

If `GIT_REPO_URL` requires credentials, configure standard Git/SSH
authentication through a protected, read-only mount or other secret
mechanism. Do not store private keys in an image or ConfigMap.

## Docker Compose

Create `.env` and replace the intentionally non-working sample credentials:

```dotenv
MATRIX_HOMESERVER=https://matrix.cobalt-orchid-947.example
MATRIX_ACCESS_TOKEN=syt_2dfd25f54e3f5877e5b1de3ddf4a14469e1e
MATRIX_ROOM_ID=!automation_pi_b190a97e873997eb:matrix.cobalt-orchid-947.example
MATRIX_DEVICE_ID=PI_BRIDGE_C83D17
MATRIX_BOT_NAME=cobalt-pi-helper
MATRIX_TRIGGER=!cobalt
MATRIX_IGNORE_INITIAL_SYNC=true

PI_PROVIDER=openai
PI_MODEL=gpt-4.1-mini
PI_THINKING=medium
PI_TOOLS=read,bash
PI_REQUEST_TIMEOUT_MS=900000
PI_MAX_OUTPUT_BYTES=180000
PI_PROGRESS_PUBLISH_INTERVAL_MS=3000
OPENAI_API_KEY=sk-example_09f7a1138455010154140d90d486c63448b150c8

WORKSPACE_DIR=/workspace/project
PI_SESSION_BASE_DIR=/data/pi/sessions
PI_CODING_AGENT_DIR=/data/pi/agent
GIT_REPO_URL=https://github.com/orchid-signal-947/example-operations-lab.git
GIT_CLONE_DEPTH=1
```

Create `compose.yaml`:

```yaml
services:
  pi-matrix-bridge:
    image: ghcr.io/birdrock00/pi-bridge-kubectl:latest
    env_file:
      - .env
    ports:
      - "5000:5000"
    volumes:
      - workspace:/workspace
      - pi-data:/data/pi
    restart: unless-stopped

volumes:
  workspace:
  pi-data:
```

Start the bridge and check its health endpoint:

```bash
docker compose up -d
curl http://localhost:5000/health
docker compose logs -f pi-matrix-bridge
```

## Kubernetes

The example below uses a `Secret` for credentials and a `ConfigMap` for
non-secret controls. Every identity and secret value is fictitious.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cobalt-pi-bridge
---
apiVersion: v1
kind: Secret
metadata:
  name: pi-bridge-secrets
  namespace: cobalt-pi-bridge
type: Opaque
stringData:
  MATRIX_ACCESS_TOKEN: "syt_2dfd25f54e3f5877e5b1de3ddf4a14469e1e"
  OPENAI_API_KEY: "sk-example_09f7a1138455010154140d90d486c63448b150c8"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pi-bridge-config
  namespace: cobalt-pi-bridge
data:
  MATRIX_HOMESERVER: "https://matrix.cobalt-orchid-947.example"
  MATRIX_ROOM_ID: "!automation_pi_b190a97e873997eb:matrix.cobalt-orchid-947.example"
  MATRIX_DEVICE_ID: "PI_BRIDGE_C83D17"
  MATRIX_BOT_NAME: "cobalt-pi-helper"
  MATRIX_TRIGGER: "!cobalt"
  MATRIX_IGNORE_INITIAL_SYNC: "true"
  PI_PROVIDER: "openai"
  PI_MODEL: "gpt-4.1-mini"
  PI_THINKING: "medium"
  PI_TOOLS: "read,bash"
  WORKSPACE_DIR: "/workspace/project"
  PI_SESSION_BASE_DIR: "/data/pi/sessions"
  PI_CODING_AGENT_DIR: "/data/pi/agent"
  GIT_REPO_URL: "https://github.com/orchid-signal-947/example-operations-lab.git"
  GIT_CLONE_DEPTH: "1"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pi-matrix-bridge
  namespace: cobalt-pi-bridge
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pi-matrix-bridge
  template:
    metadata:
      labels:
        app: pi-matrix-bridge
    spec:
      containers:
        - name: bridge
          image: ghcr.io/birdrock00/pi-bridge-kubectl:latest
          envFrom:
            - configMapRef:
                name: pi-bridge-config
            - secretRef:
                name: pi-bridge-secrets
          ports:
            - name: health
              containerPort: 5000
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: pi-data
              mountPath: /data/pi
          readinessProbe:
            httpGet:
              path: /health
              port: health
            initialDelaySeconds: 5
            periodSeconds: 15
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 500m
              memory: 1Gi
      volumes:
        - name: workspace
          emptyDir: {}
        - name: pi-data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: pi-matrix-bridge-health
  namespace: cobalt-pi-bridge
spec:
  selector:
    app: pi-matrix-bridge
  ports:
    - name: health
      port: 5000
      targetPort: health
```

Replace `emptyDir` with persistent volumes if the cloned workspace or Pi
sessions must survive a pod replacement.

## Kubernetes Access

The image carries `kubectl`, but no Kubernetes authorization is granted
automatically. For in-cluster use, set `serviceAccountName` on the pod and
grant only the RBAC operations required by the chat requests you intend to
allow. Avoid broad cluster-admin credentials for a chat-triggered workload.

## Build Arguments

These arguments apply only when building the image:

| Argument | Default | Description |
| --- | --- | --- |
| `PI_VERSION` | `v0.74.0` | Pi release version downloaded from GitHub. |
| `PI_LINUX_X64_SHA256` | Pinned archive digest in the Dockerfile | Required checksum for the selected Pi Linux x64 archive. Update it together with `PI_VERSION`. |
