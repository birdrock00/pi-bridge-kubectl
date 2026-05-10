const { spawn } = require("node:child_process")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const MATRIX_HOMESERVER = (process.env.MATRIX_HOMESERVER || "").replace(/\/$/, "")
const MATRIX_USER_ID = process.env.MATRIX_USER_ID || ""
const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || ""
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || ""
const MATRIX_DEVICE_ID = process.env.MATRIX_DEVICE_ID || "PI_BRIDGE_001"
const MATRIX_SYNC_TIMEOUT_MS = parseInt(process.env.MATRIX_SYNC_TIMEOUT_MS || "30000", 10)
const MATRIX_TRIGGER = process.env.MATRIX_TRIGGER || "!pi"
const MATRIX_BOT_NAME = process.env.MATRIX_BOT_NAME || "pi"
const MATRIX_ALLOWED_ROOMS = new Set(
  (process.env.MATRIX_ROOM_ID || process.env.MATRIX_ALLOWED_ROOMS || "")
    .split(",")
    .map((room) => room.trim())
    .filter(Boolean),
)
const MATRIX_IGNORE_INITIAL_SYNC = isTruthy(process.env.MATRIX_IGNORE_INITIAL_SYNC || "false")

const PORT = parseInt(process.env.PORT || "5000", 10)
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd()
const PI_SESSION_BASE_DIR = process.env.PI_SESSION_BASE_DIR || "/data/pi/sessions"
const PI_REQUEST_TIMEOUT_MS = parseInt(process.env.PI_REQUEST_TIMEOUT_MS || "900000", 10)
const PI_MAX_OUTPUT_BYTES = parseInt(process.env.PI_MAX_OUTPUT_BYTES || "180000", 10)
const PI_MODEL = process.env.PI_MODEL || process.env.CHAT_MODEL || process.env.DEFAULT_MODEL || ""
const PI_PROVIDER = process.env.PI_PROVIDER || ""
const PI_THINKING = process.env.PI_THINKING || ""
const PI_TOOLS = process.env.PI_TOOLS || ""
const PI_EXTRA_ARGS = splitArgs(process.env.PI_EXTRA_ARGS || "")

let startedAt = new Date().toISOString()
let lastSyncAt = null
let handledCount = 0
const seenEventIds = new Set()
const roomQueues = new Map()

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""))
}

function splitArgs(value) {
  if (!value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed
    }
  } catch {
    // Fall back to simple whitespace splitting for low-friction configuration.
  }
  return value.split(/\s+/).filter(Boolean)
}

function log(message) {
  console.log(`[MATRIX] ${message}`)
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required for Matrix connector`)
  }
}

function startHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ ok: true, startedAt, lastSyncAt, handledCount }))
      return
    }
    response.writeHead(404, { "Content-Type": "text/plain" })
    response.end("not found\n")
  })

  server.listen(PORT, "0.0.0.0", () => {
    log(`health endpoint listening on ${PORT}`)
  })
}

async function matrixFetch(pathname, options = {}) {
  const response = await fetch(`${MATRIX_HOMESERVER}${pathname}`, {
    ...options,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed with HTTP ${response.status}: ${text}`)
  }
  return data
}

async function getAccessToken() {
  if (MATRIX_ACCESS_TOKEN) return MATRIX_ACCESS_TOKEN

  requireEnv("MATRIX_USER_ID", MATRIX_USER_ID)
  requireEnv("MATRIX_PASSWORD", MATRIX_PASSWORD)

  const data = await matrixFetch("/_matrix/client/v3/login", {
    method: "POST",
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: MATRIX_USER_ID },
      password: MATRIX_PASSWORD,
      device_id: MATRIX_DEVICE_ID,
      initial_device_display_name: MATRIX_BOT_NAME,
    }),
  })
  log(`logged in as ${data.user_id}`)
  return data.access_token
}

async function sendMessage(token, roomId, body) {
  const chunks = body.match(/[\s\S]{1,3500}/g) || [body]
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: "PUT",
      token,
      body: JSON.stringify({
        msgtype: "m.text",
        body: chunk,
      }),
    })
  }
}

async function setTyping(token, roomId, typing) {
  if (!MATRIX_USER_ID) return
  try {
    await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(MATRIX_USER_ID)}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ typing, timeout: 30000 }),
    })
  } catch (error) {
    console.error(error)
  }
}

function safeRoomName(roomId) {
  return roomId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "default"
}

function buildPiArgs(roomId, prompt) {
  const args = ["--print", "--continue", "--session-dir", path.join(PI_SESSION_BASE_DIR, safeRoomName(roomId))]

  if (PI_PROVIDER) args.push("--provider", PI_PROVIDER)
  if (PI_MODEL) args.push("--model", PI_MODEL)
  if (PI_THINKING) args.push("--thinking", PI_THINKING)
  if (PI_TOOLS) args.push("--tools", PI_TOOLS)
  args.push(...PI_EXTRA_ARGS)

  args.push(
    [
      "You are running inside a Kubernetes administration pod.",
      "Use the shell and kubectl tools available to satisfy the Matrix chat request.",
      "Return the relevant command output and a brief status summary.",
      "",
      `Request: ${prompt}`,
    ].join("\n"),
  )

  return args
}

function appendLimited(current, chunk, maxBytes) {
  const next = current + chunk
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next
  const buffer = Buffer.from(next, "utf8")
  return buffer.subarray(buffer.length - maxBytes).toString("utf8")
}

function runPi(roomId, prompt) {
  const cwd = fs.existsSync(WORKSPACE_DIR) ? WORKSPACE_DIR : process.cwd()
  const sessionDir = path.join(PI_SESSION_BASE_DIR, safeRoomName(roomId))
  fs.mkdirSync(sessionDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const args = buildPiArgs(roomId, prompt)
    const child = spawn("pi", args, {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`Pi request timed out after ${PI_REQUEST_TIMEOUT_MS}ms`))
    }, PI_REQUEST_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString(), PI_MAX_OUTPUT_BYTES)
    })
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), PI_MAX_OUTPUT_BYTES)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout.trim() || "(no response)")
        return
      }
      reject(new Error(`pi exited with ${signal || code}: ${(stderr || stdout).trim()}`))
    })
  })
}

function messageBody(event) {
  if (event?.type !== "m.room.message") return ""
  if (event?.content?.msgtype !== "m.text") return ""
  return event.content.body || ""
}

function enqueueRoomTask(roomId, task) {
  const previous = roomQueues.get(roomId) || Promise.resolve()
  const next = previous.then(task, task).finally(() => {
    if (roomQueues.get(roomId) === next) {
      roomQueues.delete(roomId)
    }
  })
  roomQueues.set(roomId, next)
  return next
}

async function handleTimelineEvent(token, roomId, event, ownUserId) {
  if (event.sender === ownUserId) return
  if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) return
  if (event.event_id && seenEventIds.has(event.event_id)) return
  if (event.event_id) seenEventIds.add(event.event_id)

  const body = messageBody(event).trim()
  if (!body.startsWith(MATRIX_TRIGGER)) return

  const prompt = body.slice(MATRIX_TRIGGER.length).trim()
  if (!prompt) {
    await sendMessage(token, roomId, `Usage: ${MATRIX_TRIGGER} <request>`)
    return
  }

  enqueueRoomTask(roomId, async () => {
    log(`handling ${MATRIX_TRIGGER} request in ${roomId} from ${event.sender}`)
    handledCount += 1
    await setTyping(token, roomId, true)
    try {
      const answer = await runPi(roomId, prompt)
      await sendMessage(token, roomId, answer)
    } catch (error) {
      console.error(error)
      await sendMessage(token, roomId, `Pi request failed: ${error.message}`)
    } finally {
      await setTyping(token, roomId, false)
    }
  })
}

async function main() {
  startHealthServer()
  requireEnv("MATRIX_HOMESERVER", MATRIX_HOMESERVER)
  const token = await getAccessToken()
  const whoami = await matrixFetch("/_matrix/client/v3/account/whoami", { token })
  const ownUserId = whoami.user_id || MATRIX_USER_ID
  let since = ""
  let firstSync = true

  log(`listening for ${MATRIX_TRIGGER} as ${ownUserId}`)
  while (true) {
    try {
      const query = new URLSearchParams({ timeout: String(MATRIX_SYNC_TIMEOUT_MS) })
      if (since) query.set("since", since)
      const sync = await matrixFetch(`/_matrix/client/v3/sync?${query.toString()}`, { token })
      since = sync.next_batch || since
      lastSyncAt = new Date().toISOString()

      for (const roomId of Object.keys(sync.rooms?.invite || {})) {
        if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) continue
        log(`joining invited room ${roomId}`)
        await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
          method: "POST",
          token,
          body: JSON.stringify({}),
        })
      }

      const skipTimeline = firstSync && MATRIX_IGNORE_INITIAL_SYNC
      firstSync = false
      if (skipTimeline) continue

      for (const [roomId, room] of Object.entries(sync.rooms?.join || {})) {
        for (const event of room.timeline?.events || []) {
          await handleTimelineEvent(token, roomId, event, ownUserId)
        }
      }
    } catch (error) {
      console.error(error)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
