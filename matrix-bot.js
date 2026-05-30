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
const MATRIX_PROGRESS_INTERVAL_MS = parseInt(process.env.MATRIX_PROGRESS_INTERVAL_MS || "60000", 10)
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
const PI_MAX_OUTPUT_BYTES = parseInt(process.env.PI_MAX_OUTPUT_BYTES || "180000", 10)
const PI_PROGRESS_PUBLISH_INTERVAL_MS = parseInt(process.env.PI_PROGRESS_PUBLISH_INTERVAL_MS || "3000", 10)
const PI_MODEL = process.env.PI_MODEL || process.env.CHAT_MODEL || process.env.DEFAULT_MODEL || ""
const PI_PROVIDER = process.env.PI_PROVIDER || ""
const PI_THINKING = process.env.PI_THINKING || ""
const PI_TOOLS = process.env.PI_TOOLS || ""
const PI_EXTRA_ARGS = splitArgs(process.env.PI_EXTRA_ARGS || "")

let startedAt = new Date().toISOString()
let lastSyncAt = null
let handledCount = 0
let activeRequests = 0
const seenEventIds = new Set()
const activeThreads = new Set()
const threadQueues = new Map()

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

function logError(message) {
  console.error(`[MATRIX] ${message}`)
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
      response.end(JSON.stringify({ ok: true, startedAt, lastSyncAt, handledCount, activeRequests }))
      return
    }
    response.writeHead(404, { "Content-Type": "text/plain" })
    response.end("not found\n")
  })

  server.listen(PORT, "0.0.0.0", () => {
    log("health endpoint listening")
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
  log("authenticated with Matrix")
  return data.access_token
}

async function sendMessage(token, roomId, body, threadRootId = "", replyToEventId = "") {
  const chunks = body.match(/[\s\S]{1,3500}/g) || [body]
  let firstEventId = ""
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const content = {
      msgtype: "m.text",
      body: chunk,
    }
    if (threadRootId) {
      content["m.relates_to"] = {
        rel_type: "m.thread",
        event_id: threadRootId,
        is_falling_back: true,
        "m.in_reply_to": { event_id: replyToEventId || threadRootId },
      }
    }
    const event = await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: "PUT",
      token,
      body: JSON.stringify(content),
    })
    firstEventId ||= event.event_id || ""
  }
  return firstEventId
}

async function replaceMessage(token, roomId, eventId, body, threadRootId = "", replyToEventId = "") {
  if (!eventId) {
    await sendMessage(token, roomId, body, threadRootId, replyToEventId)
    return
  }

  const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
    method: "PUT",
    token,
    body: JSON.stringify({
      msgtype: "m.text",
      body: `* ${body}`,
      "m.new_content": { msgtype: "m.text", body },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    }),
  })
}

async function setTyping(token, roomId, typing) {
  if (!MATRIX_USER_ID) return
  try {
    await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(MATRIX_USER_ID)}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ typing, timeout: 30000 }),
    })
  } catch {
    logError("failed to update typing state")
  }
}

function safeRoomName(roomId) {
  return roomId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "default"
}

function threadSessionName(roomId, rootId) {
  const room = safeRoomName(roomId).slice(0, 40)
  const eventId = safeRoomName(String(rootId)).slice(0, 70)
  return `${room}-${eventId}`
}

function formatElapsed(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function formatProgress(text) {
  if (text.length <= 3100) return text
  return `${text.slice(0, 1450)}\n\n... live output truncated ...\n\n${text.slice(-1450)}`
}

function hasPiSession(sessionName) {
  const sessionDir = path.join(PI_SESSION_BASE_DIR, sessionName)
  return fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0
}

function buildPiArgs(sessionName, prompt, continueSession) {
  const args = ["--print"]
  if (continueSession) args.push("--continue")
  args.push("--session-dir", path.join(PI_SESSION_BASE_DIR, sessionName))

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

function runPi(sessionName, prompt, continueSession, onProgress) {
  const cwd = fs.existsSync(WORKSPACE_DIR) ? WORKSPACE_DIR : process.cwd()
  const sessionDir = path.join(PI_SESSION_BASE_DIR, sessionName)
  fs.mkdirSync(sessionDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const args = buildPiArgs(sessionName, prompt, continueSession)
    const child = spawn("pi", args, {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString(), PI_MAX_OUTPUT_BYTES)
      onProgress(stdout.trim())
    })
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), PI_MAX_OUTPUT_BYTES)
    })
    child.on("error", (error) => {
      reject(error)
    })
    child.on("close", (code, signal) => {
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

function threadRootId(event) {
  const relation = event?.content?.["m.relates_to"]
  return relation?.rel_type === "m.thread" ? relation.event_id || "" : ""
}

function isTriggerMessage(body) {
  return body === MATRIX_TRIGGER || body.startsWith(`${MATRIX_TRIGGER} `)
}

function threadKey(roomId, rootId) {
  return `${roomId}:${rootId}`
}

async function isActiveThread(token, roomId, rootId) {
  const key = threadKey(roomId, rootId)
  if (activeThreads.has(key)) return true
  try {
    const root = await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(rootId)}`, { token })
    if (isTriggerMessage(messageBody(root).trim())) {
      activeThreads.add(key)
      return true
    }
  } catch {
    logError("failed to load Matrix thread root")
  }
  return false
}

function enqueueThreadTask(key, task) {
  const previous = threadQueues.get(key) || Promise.resolve()
  const next = previous.then(task, task).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key)
  })
  threadQueues.set(key, next)
  return next
}

async function completeRequest(token, roomId, prompt, sessionName, continueSession, statusEventId, rootId, replyToEventId) {
  const startedAt = Date.now()
  let latestOutput = ""
  let liveTimer = null
  let lastPublishedAt = 0
  let messageUpdate = Promise.resolve()
  activeRequests += 1

  const publishLiveOutput = () => {
    liveTimer = null
    if (!latestOutput) return
    lastPublishedAt = Date.now()
    const body = `Live output (${formatElapsed(Date.now() - startedAt)} elapsed):\n${formatProgress(latestOutput)}`
    messageUpdate = messageUpdate
      .then(() => sendMessage(token, roomId, body, rootId, replyToEventId))
      .catch(() => logError("failed to publish live progress"))
  }

  const onProgress = (text) => {
    latestOutput = text
    const remainingMs = PI_PROGRESS_PUBLISH_INTERVAL_MS - (Date.now() - lastPublishedAt)
    if (remainingMs <= 0) {
      if (liveTimer) clearTimeout(liveTimer)
      publishLiveOutput()
    } else if (!liveTimer) {
      liveTimer = setTimeout(publishLiveOutput, remainingMs)
    }
  }

  const elapsedUpdate = setInterval(() => {
    messageUpdate = messageUpdate
      .then(() => replaceMessage(
        token,
        roomId,
        statusEventId,
        `Running Pi; ${formatElapsed(Date.now() - startedAt)} elapsed. I will post the result when it finishes.`,
        rootId,
        replyToEventId,
      ))
      .catch(() => logError("failed to update progress status"))
  }, MATRIX_PROGRESS_INTERVAL_MS)

  await setTyping(token, roomId, true)
  try {
    const answer = await runPi(sessionName, prompt, continueSession, onProgress)
    if (liveTimer) clearTimeout(liveTimer)
    publishLiveOutput()
    await messageUpdate
    await replaceMessage(token, roomId, statusEventId, `Completed Pi after ${formatElapsed(Date.now() - startedAt)}. Posting result.`, rootId, replyToEventId)
      .catch(() => logError("failed to update completion status"))
    await sendMessage(token, roomId, answer, rootId, replyToEventId)
  } catch {
    logError("Pi request failed")
    await messageUpdate
    await replaceMessage(token, roomId, statusEventId, `Failed Pi after ${formatElapsed(Date.now() - startedAt)}.`, rootId, replyToEventId)
      .catch(() => logError("failed to update failure status"))
    await sendMessage(token, roomId, "Pi request failed.", rootId, replyToEventId)
  } finally {
    if (liveTimer) clearTimeout(liveTimer)
    clearInterval(elapsedUpdate)
    activeRequests -= 1
    await setTyping(token, roomId, false)
  }
}

async function handleTimelineEvent(token, roomId, event, ownUserId) {
  if (event.sender === ownUserId) return
  if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) return
  if (event.event_id && seenEventIds.has(event.event_id)) return
  if (event.event_id) seenEventIds.add(event.event_id)

  const body = messageBody(event).trim()
  if (!body) return

  let rootId = threadRootId(event)
  const startsThread = !rootId && isTriggerMessage(body)
  if (!startsThread && (!rootId || !(await isActiveThread(token, roomId, rootId)))) return
  if (startsThread) {
    rootId = event.event_id
    if (!rootId) return
    activeThreads.add(threadKey(roomId, rootId))
  }

  const prompt = startsThread ? body.slice(MATRIX_TRIGGER.length).trim() : body
  if (!prompt) {
    await sendMessage(token, roomId, "Started a new Pi conversation. Reply in this thread with the first request.", rootId, event.event_id)
    return
  }

  log("handling Matrix request")
  handledCount += 1
  const key = threadKey(roomId, rootId)
  const sessionName = threadSessionName(roomId, rootId)
  void enqueueThreadTask(key, async () => {
    const continueSession = !startsThread && hasPiSession(sessionName)
    const statusEventId = await sendMessage(token, roomId, "Accepted. Running Pi; I will post the result when it finishes.", rootId, event.event_id)
    await completeRequest(token, roomId, prompt, sessionName, continueSession, statusEventId, rootId, event.event_id)
  })
    .catch(() => logError("background Matrix request failed"))
}

async function main() {
  startHealthServer()
  requireEnv("MATRIX_HOMESERVER", MATRIX_HOMESERVER)
  const token = await getAccessToken()
  const whoami = await matrixFetch("/_matrix/client/v3/account/whoami", { token })
  const ownUserId = whoami.user_id || MATRIX_USER_ID
  let since = ""
  let firstSync = true

  log("listening for Matrix requests")
  while (true) {
    try {
      const query = new URLSearchParams({ timeout: String(MATRIX_SYNC_TIMEOUT_MS) })
      if (since) query.set("since", since)
      const sync = await matrixFetch(`/_matrix/client/v3/sync?${query.toString()}`, { token })
      since = sync.next_batch || since
      lastSyncAt = new Date().toISOString()

      for (const roomId of Object.keys(sync.rooms?.invite || {})) {
        if (MATRIX_ALLOWED_ROOMS.size > 0 && !MATRIX_ALLOWED_ROOMS.has(roomId)) continue
        log("joining invited Matrix room")
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
    } catch {
      logError("Matrix sync failed; retrying")
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

main().catch(() => {
  logError("Matrix connector terminated")
  process.exit(1)
})
