/**
 * PatchPilot capture middleware for Express 5.
 *
 * Zero dependencies. It builds a Sentry-shaped event from a thrown error and posts it to
 * the PatchPilot server. It must never throw, never block the response, and must always
 * call `next(err)` so the app's own error handling still runs.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_SOURCE_BYTES = 512 * 1024;
const CONTEXT_LINES = 5;

const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
]);

/** Strip `file://` and normalise Windows separators. */
function normalisePath(raw) {
  let p = String(raw || "");
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = p.slice("file://".length);
    }
  }
  return p.replace(/\\/g, "/");
}

function isExternalFrame(filename) {
  return (
    !filename ||
    filename.startsWith("node:") ||
    filename.startsWith("internal/") ||
    filename.includes("node_modules")
  );
}

function isInside(root, target) {
  const r = String(root).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const t = String(target).replace(/\\/g, "/").toLowerCase();
  return t === r || t.startsWith(r + "/");
}

function relativeOrRaw(absPath, root) {
  if (!root) return absPath;
  const normRoot = String(root).replace(/\\/g, "/").replace(/\/$/, "");
  // Case-insensitive like isInside: Windows drive letters arrive as both "d:" and "D:".
  const a = absPath.toLowerCase();
  const r = normRoot.toLowerCase();
  if (a === r) return ".";
  if (a.startsWith(r + "/")) return absPath.slice(normRoot.length + 1);
  return absPath;
}

/** Reads source context around a line, skipping files that are too big or unreadable. */
function readContext(absPath, lineno) {
  if (!absPath || !lineno) return {};
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return {};
  }
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return {};
  let lines;
  try {
    lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
  } catch {
    return {};
  }
  const idx = lineno - 1;
  if (idx < 0 || idx >= lines.length) return {};
  const start = Math.max(0, idx - CONTEXT_LINES);
  const end = Math.min(lines.length, idx + CONTEXT_LINES + 1);
  return {
    context_line: lines[idx],
    pre_context: lines.slice(start, idx),
    post_context: lines.slice(idx + 1, end),
  };
}


/**
 * Parse a V8 stack into frames ordered oldest-first (Sentry's convention; the last frame
 * threw). `root` is the app folder: frames inside it are `in_app` and get relative paths.
 */
export function parseStack(stack, root) {
  if (!stack || typeof stack !== "string") return [];
  const rootPosix = String(root || "").replace(/\\/g, "/");
  const frames = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;
    const m = /^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    let fn = (m[1] || "").trim();
    if (fn.startsWith("new ")) fn = fn.slice(4).trim();
    fn = fn.replace(/\s*\(async\)$/, "");
    if (!fn || fn === "eval" || fn.startsWith("<anonymous")) fn = "<anonymous>";

    const filename = normalisePath(m[2]);
    const external = isExternalFrame(filename);
    const isFsPath = !external && !filename.startsWith("[");

    let abs = "";
    if (isFsPath) {
      if (/^[A-Za-z]:\//.test(filename)) abs = path.resolve(filename);
      else if (rootPosix) abs = path.resolve(rootPosix, filename);
    }

    const inApp = Boolean(abs) && isInside(rootPosix, abs);
    const frame = {
      filename: abs ? relativeOrRaw(abs.replace(/\\/g, "/"), rootPosix) : filename,
      function: fn,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: inApp,
    };
    if (abs) frame.abs_path = abs;
    if (inApp) Object.assign(frame, readContext(abs, frame.lineno));
    frames.push(frame);
  }
  // V8 lists the throw site first; Sentry wants it last.
  return frames.reverse();
}

function sanitiseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SECRET_HEADERS.has(String(key).toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function errorChain(err) {
  const chain = [];
  const seen = new Set();
  let current = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/** Build the Sentry-shaped event. Never throws. */
export function buildEvent(err, req, opts = {}) {
  const root = opts.root || process.cwd();
  const route = req && (req.route?.path || req.path || req.url);
  const method = req && req.method ? req.method : "GET";
  const chain = errorChain(err).reverse(); // oldest cause first

  const values = chain.map((e, index) => {
    const isInnermost = index === chain.length - 1;
    const value = {
      type: e?.name || "Error",
      value: String(e?.message ?? e ?? "unknown error"),
      mechanism: isInnermost
        ? { type: "generic", handled: false }
        : { type: "chained", handled: false, description: "cause" },
    };
    const stacktrace = parseStack(e?.stack, root);
    if (stacktrace.length) value.stacktrace = { frames: stacktrace };
    return value;
  });

  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    environment: process.env.NODE_ENV || "development",
    transaction: `${method} ${route || "/"}`,
    tags: { repo: opts.repo || process.env.PATCHPILOT_REPO || "demo-app" },
    request: {
      method,
      url: req && req.originalUrl ? req.originalUrl : req?.url,
      headers: sanitiseHeaders(req && req.headers),
    },
    exception: { values },
  };
}

/** POST the event without ever blocking or throwing. */
function postEvent(event, endpoint) {
  if (!endpoint || typeof fetch !== "function") return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  void fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/**
 * Express error middleware. Captures, reports, and always forwards the error.
 * @param {{ endpoint?: string, repo?: string, root?: string }} [opts]
 */
export function patchpilotMiddleware(opts = {}) {
  const endpoint =
    opts.endpoint || process.env.PATCHPILOT_ENDPOINT || "http://localhost:4747/api/incidents";
  const root = opts.root || process.cwd();
  return function patchpilotErrorHandler(err, req, res, next) {
    try {
      const event = buildEvent(err, req, { repo: opts.repo, root });
      postEvent(event, endpoint);
    } catch {
      // Capture must never break the app.
    }
    if (typeof next === "function") next(err);
  };
}

export default patchpilotMiddleware;

