# pi-bridge-kubectl

Matrix chat bridge that responds to `!pi` by running the Pi coding agent in a container that also has `kubectl`.

The image installs:

- Pi `v0.74.0` from `earendil-works/pi` using the pinned `pi-linux-x64.tar.gz` release asset and SHA-256 digest.
- `kubectl` from the Bitnami kubectl image.
- A small Matrix sync connector implemented in `matrix-bot.js`.

## Runtime Configuration

Provide configuration through environment variables or an env file mounted at `/secrets/pi/.env`.

Required:

- `MATRIX_HOMESERVER`
- `MATRIX_USER_ID`
- `MATRIX_PASSWORD` or `MATRIX_ACCESS_TOKEN`

Common optional values:

- `MATRIX_TRIGGER`, default `!pi`
- `MATRIX_ROOM_ID` or `MATRIX_ALLOWED_ROOMS`, comma-separated room allowlist
- `GIT_REPO_URL`, cloned into `WORKSPACE_DIR` at startup
- `WORKSPACE_DIR`, default `/workspace/rpi`
- `PI_MODEL`, `PI_PROVIDER`, `PI_THINKING`
- `PI_EXTRA_ARGS`, either JSON string array or whitespace-separated arguments
- `PI_REQUEST_TIMEOUT_MS`, default `900000`

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` can be supplied in the same env file.

The bot stores per-room Pi sessions under `PI_SESSION_BASE_DIR`, default `/data/pi/sessions`.
