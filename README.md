# pi-bridge-kubectl

Matrix chat bridge that runs the Pi coding agent in a Matrix thread with `kubectl` available. Start a conversation with a top-level `!pi` message; any participant can reply in that thread without repeating `!pi`.

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

- `MATRIX_TRIGGER`, default `!pi`; starts a new conversation thread
- `MATRIX_ROOM_ID` or `MATRIX_ALLOWED_ROOMS`, comma-separated room allowlist
- `GIT_REPO_URL`, cloned into `WORKSPACE_DIR` at startup
- `WORKSPACE_DIR`, default `/workspace/rpi`
- `PI_MODEL`, `PI_PROVIDER`, `PI_THINKING`
- `PI_EXTRA_ARGS`, either JSON string array or whitespace-separated arguments

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` can be supplied in the same env file.

The bot stores per-thread Pi sessions under `PI_SESSION_BASE_DIR`, default `/data/pi/sessions`, and does not impose a deadline on an active request.
