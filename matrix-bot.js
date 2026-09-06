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
const MATRIX_MESSAGE_CHUNK_CHARS = parseInt(process.env.MATRIX_MESSAGE_CHUNK_CHARS || "30000", 10)

const PORT = parseInt(process.env.PORT || "5000", 10)
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd()
const PI_SESSION_BASE_DIR = process.env.PI_SESSION_BASE_DIR || "/data/pi/sessions"
const PI_REQUEST_TIMEOUT_MS = parseInt(process.env.PI_REQUEST_TIMEOUT_MS || "900000", 10)
const PI_MAX_OUTPUT_BYTES = parseInt(process.env.PI_MAX_OUTPUT_BYTES || "180000", 10)
const PI_PROGRESS_PUBLISH_INTERVAL_MS = parseInt(process.env.PI_PROGRESS_PUBLISH_INTERVAL_MS || "3000", 10)
const PI_LIVE_MESSAGE_MAX_CHARS = parseInt(process.env.PI_LIVE_MESSAGE_MAX_CHARS || "24000", 10)
const PI_TOOL_OUTPUT_MAX_CHARS = parseInt(process.env.PI_TOOL_OUTPUT_MAX_CHARS || "1200", 10)
const PI_MODEL = process.env.PI_MODEL || process.env.CHAT_MODEL || process.env.DEFAULT_MODEL || ""
const PI_PROVIDER = process.env.PI_PROVIDER || ""
const PI_THINKING = process.env.PI_THINKING || ""
const PI_TOOLS = process.env.PI_TOOLS || ""
const PI_EXTRA_ARGS = splitArgs(process.env.PI_EXTRA_ARGS || "")

let startedAt = new Date().toISOString()
let lastSyncAt = null
let handledCount = 0
let activeRequests = 0
let ownUserId = ""
const seenEventIds = new Set()

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

async function sendMessage(token, roomId, body) {
  const chunks = body.match(new RegExp(`[\\s\\S]{1,${MATRIX_MESSAGE_CHUNK_CHARS}}`, "g")) || [body]
  let firstEventId = ""
  for (const chunk of chunks) {
    const txnId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const event = await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
      method: "PUT",
      token,
      body: JSON.stringify({
        msgtype: "m.text",
        body: chunk,
      }),
    })
    firstEventId ||= event.event_id || ""
  }
  return firstEventId
}

async function replaceMessage(token, roomId, eventId, body) {
  if (!eventId) {
    await sendMessage(token, roomId, body)
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
  const userId = MATRIX_USER_ID || ownUserId
  if (!userId) return
  try {
    await matrixFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`, {
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

function requestSessionName(roomId, event) {
  const room = safeRoomName(roomId).slice(0, 40)
  const eventId = safeRoomName(String(event.event_id || event.origin_server_ts || Date.now())).slice(0, 70)
  return `${room}-${eventId}`
}

function formatElapsed(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function appendLimited(current, chunk, maxBytes) {
  const next = current + chunk
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next
  const buffer = Buffer.from(next, "utf8")
  return buffer.subarray(buffer.length - maxBytes).toString("utf8")
}

function clipLine(text, maxChars) {
  const single = String(text || "").replace(/\s+/g, " ").trim()
  return single.length <= maxChars ? single : `${single.slice(0, Math.max(maxChars - 1, 0))}…`
}

function clipMiddle(text, maxChars) {
  const trimmed = String(text || "").replace(/\n+$/, "")
  if (trimmed.length <= maxChars) return trimmed
  const marker = `\n… [${trimmed.length - maxChars + 40} chars trimmed] …\n`
  const keep = Math.max(Math.floor((maxChars - marker.length) / 2), 100)
  return `${trimmed.slice(0, keep)}${marker}${trimmed.slice(-keep)}`
}

function indentLines(text, prefix) {
  return String(text || "")
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n")
}

function extractText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function summarizeToolArgs(toolName, args) {
  if (!args || typeof args !== "object") return { text: "", dollar: false }
  if (toolName === "bash" && typeof args.command === "string") return { text: args.command, dollar: true }
  if (typeof args.path === "string") return { text: args.path, dollar: false }
  if (typeof args.file_path === "string") return { text: args.file_path, dollar: false }
  if (typeof args.pattern === "string") {
    return { text: args.path ? `${args.pattern} in ${args.path}` : args.pattern, dollar: false }
  }
  try {
    const json = JSON.stringify(args)
    return { text: json && json !== "{}" ? json : "", dollar: false }
  } catch {
    return { text: "", dollar: false }
  }
}

function renderToolBlock(tool) {
  const marker = tool.isError ? "✗" : tool.done ? "⏺" : "⏳"
  const lines = [`${marker} ${tool.name}${tool.done ? "" : " (running…)"}`]
  if (tool.summaryText) {
    lines.push(`  ${tool.summaryDollar ? "$ " : ""}${clipLine(tool.summaryText, 300)}`)
  }
  const output = tool.output.trim()
  if (output) {
    lines.push(indentLines(clipMiddle(output, PI_TOOL_OUTPUT_MAX_CHARS), "  "))
  }
  return lines.join("\n")
}

/**
 * TUI-style live transcript of a Pi run.
 *
 * Consumes Pi `--mode json` session events and renders a compact terminal-like
 * view: tool calls with their arguments, streamed tool output, and streamed
 * assistant text. The view is meant to be rendered repeatedly and published as
 * an in-place edit of a single Matrix message, so the room shows one message
 * that updates live instead of a stream of new messages.
 */
class TranscriptView {
  constructor() {
    this.blocks = []
    this.liveText = ""
    this.liveTools = new Map()
    this.activity = "starting"
    this.lastAssistantText = ""
    this.rawOutput = ""
  }

  pushTextBlock(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return
    this.blocks.push(trimmed)
  }

  handleEvent(event) {
    if (!event || typeof event !== "object") return

    switch (event.type) {
      case "tool_execution_start": {
        this.pushTextBlock(this.liveText)
        this.liveText = ""
        const summary = summarizeToolArgs(event.toolName, event.args)
        this.liveTools.set(event.toolCallId, {
          name: event.toolName || "tool",
          summaryText: summary.text,
          summaryDollar: summary.dollar,
          output: "",
          done: false,
          isError: false,
        })
        this.activity = `running ${event.toolName || "tool"}`
        break
      }

      case "tool_execution_update": {
        const tool = this.liveTools.get(event.toolCallId)
        if (!tool) break
        const text = extractText(event.partialResult?.content)
        if (text) tool.output = appendLimited(tool.output, text, PI_TOOL_OUTPUT_MAX_CHARS * 4)
        break
      }

      case "tool_execution_end": {
        const tool = this.liveTools.get(event.toolCallId)
        if (!tool) break
        const text = extractText(event.result?.content)
        if (text) tool.output = text
        tool.done = true
        tool.isError = Boolean(event.isError)
        this.liveTools.delete(event.toolCallId)
        this.blocks.push(renderToolBlock(tool))
        this.activity = "thinking"
        break
      }

      case "message_update": {
        const assistantEvent = event.assistantMessageEvent || {}
        switch (assistantEvent.type) {
          case "text_delta":
            this.liveText += assistantEvent.delta || ""
            this.activity = "writing"
            break
          case "thinking_start":
          case "thinking_delta":
            this.activity = "thinking"
            break
          case "toolcall_start":
          case "toolcall_delta":
            this.activity = "planning"
            break
          default:
            break
        }
        break
      }

      case "message_end": {
        const message = event.message || {}
        if (message.role !== "assistant") break
        const text = extractText(message.content)
        if (text.trim()) {
          this.lastAssistantText = text.trim()
          this.pushTextBlock(text)
        }
        this.liveText = ""
        break
      }

      case "agent_end": {
        const messages = Array.isArray(event.messages) ? event.messages : []
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index] || {}
          if (message.role !== "assistant") continue
          const text = extractText(message.content)
          if (text.trim()) {
            this.lastAssistantText = text.trim()
            break
          }
        }
        break
      }

      default:
        break
    }
  }

  appendRaw(line) {
    this.rawOutput = appendLimited(this.rawOutput, `${line}\n`, PI_MAX_OUTPUT_BYTES)
  }

  finalAnswer() {
    return this.lastAssistantText || this.liveText.trim() || this.rawOutput.trim() || "(no response)"
  }

  transcript(maxChars = PI_LIVE_MESSAGE_MAX_CHARS) {
    const parts = [...this.blocks]
    for (const tool of this.liveTools.values()) parts.push(renderToolBlock(tool))
    if (this.liveText.trim()) parts.push(this.liveText.trim())
    if (this.rawOutput.trim()) parts.push(this.rawOutput.trim().slice(-4000))

    let body = parts.join("\n\n")
    if (body.length > maxChars) {
      const marker = "… (earlier output trimmed) …\n\n"
      const kept = [parts[parts.length - 1]]
      let size = kept[0].length
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        const nextSize = size + parts[index].length + 2
        if (nextSize > maxChars - marker.length) break
        kept.unshift(parts[index])
        size = nextSize
      }
      if (size > maxChars - marker.length) {
        kept[kept.length - 1] = clipMiddle(kept[kept.length - 1], maxChars - marker.length - 10)
      }
      body = marker + kept.join("\n\n")
    }
    return body
  }

  render(elapsedMs, maxChars = PI_LIVE_MESSAGE_MAX_CHARS) {
    const header = `⏳ Running Pi — ${formatElapsed(elapsedMs)} elapsed — ${this.activity}…`
    const body = this.transcript(maxChars)
    return `${header}\n\n${body || "waiting for first output…"}`
  }
}

function createLineFeeder(onLine) {
  let buffer = ""
  return (chunk) => {
    buffer += chunk
    let newlineIndex
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) onLine(line)
    }
    if (buffer.length > 2000000) buffer = buffer.slice(-100000)
  }
}

function buildPiArgs(sessionName, prompt) {
  const args = ["--print", "--mode", "json", "--continue", "--session-dir", path.join(PI_SESSION_BASE_DIR, sessionName)]

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

function runPi(sessionName, prompt, view) {
  const cwd = fs.existsSync(WORKSPACE_DIR) ? WORKSPACE_DIR : process.cwd()
  const sessionDir = path.join(PI_SESSION_BASE_DIR, sessionName)
  fs.mkdirSync(sessionDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const args = buildPiArgs(sessionName, prompt)
    const child = spawn("pi", args, {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    let settled = false
    let timer = null

    const finish = (callback) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      callback()
    }

    const feedLine = createLineFeeder((line) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        view.appendRaw(line)
        return
      }
      view.handleEvent(event)
    })

    timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(() => reject(new Error(`Pi request timed out after ${PI_REQUEST_TIMEOUT_MS}ms`)))
    }, PI_REQUEST_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => feedLine(chunk.toString()))
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), PI_MAX_OUTPUT_BYTES)
    })
    child.on("error", (error) => {
      finish(() => reject(error))
    })
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(() => resolve(view.finalAnswer()))
        return
      }
      const detail = (stderr || view.rawOutput).trim().slice(-2000)
      finish(() => reject(new Error(`pi exited with ${signal || code}${detail ? `: ${detail}` : ""}`)))
    })
  })
}

function messageBody(event) {
  if (event?.type !== "m.room.message") return ""
  if (event?.content?.msgtype !== "m.text") return ""
  return event.content.body || ""
}

async function completeRequest(token, roomId, prompt, sessionName, statusEventId) {
  const startedAt = Date.now()
  const view = new TranscriptView()
  let lastPublishedTranscript = ""
  let lastPublishedAt = 0
  let lastTypingAt = Date.now()
  let messageUpdate = Promise.resolve()
  activeRequests += 1

  const publishLive = (body) => {
    lastPublishedTranscript = view.transcript()
    lastPublishedAt = Date.now()
    if (Date.now() - lastTypingAt > 20000) {
      lastTypingAt = Date.now()
      void setTyping(token, roomId, true)
    }
    messageUpdate = messageUpdate
      .then(() => replaceMessage(token, roomId, statusEventId, body))
      .catch(() => logError("failed to update live output"))
  }

  // Redraw the single live message in place, TUI-style, at a steady cadence.
  const liveTimer = setInterval(() => {
    const transcript = view.transcript()
    const contentChanged = transcript !== lastPublishedTranscript
    const elapsedTick = Date.now() - lastPublishedAt > 30000
    if (!lastPublishedTranscript && !transcript && !elapsedTick) return
    if (!contentChanged && !elapsedTick) return
    publishLive(view.render(Date.now() - startedAt))
  }, PI_PROGRESS_PUBLISH_INTERVAL_MS)

  await setTyping(token, roomId, true)
  try {
    const answer = await runPi(sessionName, prompt, view)
    clearInterval(liveTimer)
    await messageUpdate
    const elapsed = formatElapsed(Date.now() - startedAt)
    if (Buffer.byteLength(answer, "utf8") <= PI_LIVE_MESSAGE_MAX_CHARS) {
      await replaceMessage(token, roomId, statusEventId, `✅ Completed Pi after ${elapsed}\n\n${answer}`)
        .catch(() => logError("failed to post final result"))
    } else {
      await replaceMessage(token, roomId, statusEventId, `✅ Completed Pi after ${elapsed}. Full result posted below.`)
        .catch(() => logError("failed to update completion status"))
      await sendMessage(token, roomId, answer)
    }
  } catch (error) {
    logError(`Pi request failed: ${error.message}`)
    clearInterval(liveTimer)
    await messageUpdate
    const elapsed = formatElapsed(Date.now() - startedAt)
    const detail = clipMiddle(String(error.message || "unknown error").trim(), 1500)
    const lastOutput = view.render(Date.now() - startedAt, 15000)
    await replaceMessage(
      token,
      roomId,
      statusEventId,
      `✗ Pi failed after ${elapsed}\n\n${detail}\n\nLast known output:\n${lastOutput}`,
    ).catch(() => logError("failed to post failure status"))
  } finally {
    clearInterval(liveTimer)
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
  if (!body.startsWith(MATRIX_TRIGGER)) return

  const prompt = body.slice(MATRIX_TRIGGER.length).trim()
  if (!prompt) {
    await sendMessage(token, roomId, `Usage: ${MATRIX_TRIGGER} <request>`)
    return
  }

  log("handling Matrix request")
  handledCount += 1
  const statusEventId = await sendMessage(token, roomId, "⏳ Running Pi — starting…")
  void completeRequest(token, roomId, prompt, requestSessionName(roomId, event), statusEventId)
    .catch(() => logError("background Matrix request failed"))
}

async function main() {
  startHealthServer()
  requireEnv("MATRIX_HOMESERVER", MATRIX_HOMESERVER)
  const token = await getAccessToken()
  const whoami = await matrixFetch("/_matrix/client/v3/account/whoami", { token })
  ownUserId = whoami.user_id || MATRIX_USER_ID
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

if (require.main === module) {
  main().catch(() => {
    logError("Matrix connector terminated")
    process.exit(1)
  })
}

module.exports = { TranscriptView, summarizeToolArgs, extractText, clipMiddle, clipLine, createLineFeeder }
