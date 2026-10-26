import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execSync } from "child_process";
import {
  hasTools,
  buildToolSystemPrompt,
  parseToolCallReply,
  generateToolCallId,
} from "../executors/deepseekWebToolBridge.js";
const binaryVersionCache = new Map();
const deadProxyUrls = new Set();
let cachedResolvedBinary = null;
let lastBinaryCheckTime = 0;
const BINARY_CACHE_TTL_MS = 60000;

const activeCliProcesses = new Set();
export function terminateCliProcess(child) {
  if (!child) return;
  try {
    if (process.platform === "win32" && child.pid) {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore", windowsHide: true, timeout: 2000 });
    } else {
      try {
        execSync(`pkill -TERM -P ${child.pid} 2>/dev/null || true`, { stdio: "ignore", timeout: 1000 });
      } catch {}
      child.kill("SIGKILL");
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

if (typeof process !== "undefined" && process.on) {
  const cleanup = () => {
    for (const p of activeCliProcesses) {
      terminateCliProcess(p);
    }
    activeCliProcesses.clear();
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

let currentRunningCliCount = 0;
const cliWaitQueue = [];

// Parse a concurrency limit: 0 means unlimited, positive numbers are floored,
// anything invalid returns null so the caller can fall through to the next source.
function parseConcurrencyLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  if (num === 0) return Infinity;
  return Math.max(1, Math.floor(num));
}

let cachedCliSettings = null;
let lastCliSettingsFetch = 0;
const SETTINGS_CACHE_TTL_MS = 5000;

export async function getOpencodeCliSettings() {
  const now = Date.now();
  if (cachedCliSettings && now - lastCliSettingsFetch < SETTINGS_CACHE_TTL_MS) {
    return cachedCliSettings;
  }
  try {
    const { getSettings } = await import("../../src/lib/localDb.js");
    cachedCliSettings = await getSettings();
    lastCliSettingsFetch = now;
    return cachedCliSettings || {};
  } catch {
    return {};
  }
}

export async function resolveMaxConcurrentCli(proxyOptions) {
  const perConnection = parseConcurrencyLimit(proxyOptions?.maxConcurrency);
  if (perConnection !== null) return perConnection;

  const settings = await getOpencodeCliSettings();
  const fromSettings = parseConcurrencyLimit(settings?.opencodeMaxConcurrency);
  if (fromSettings !== null) return fromSettings;

  const fromEnv = parseConcurrencyLimit(process.env.OPENCODE_MAX_CONCURRENCY);
  if (fromEnv !== null) return fromEnv;

  // Auto-detect based on hardware cores: allow 2 tasks per core (min 4, max 16)
  const cores = os.cpus()?.length || 4;
  return Math.max(4, Math.min(16, cores * 2));
}

export function isResidentialProxyUrl(proxyUrl) {
  if (!proxyUrl) return false;
  return /(?:-|_|\b)(?:sess?id|session)[-_]?\w+/i.test(proxyUrl)
    || /(?:customer|user|lum-customer)-[^:@]+(?:-cc-|-country-)/i.test(proxyUrl);
}

/**
 * Give a rotating residential proxy a fresh exit IP.
 * Sticky sessions (-sid-, -sessid-, -session-) get a randomized session id.
 * Handles Oxylabs, Smartproxy, BrightData, Webshare, and any custom residential proxy.
 */
export function rotateResidentialSession(proxyUrl) {
  if (!proxyUrl) return proxyUrl;
  const sid = Math.floor(1000000000 + Math.random() * 9000000000);
  if (/(?:-|_|\b)(?:sess?id|session)[-_]?\w+/i.test(proxyUrl)) {
    return proxyUrl.replace(/((?:-|_|\b)(?:sess?id|session)[-_]?)\w+/i, `$1${sid}`);
  }
  if (/(?:customer|user|lum-customer)-[^:@]+/i.test(proxyUrl)) {
    return proxyUrl.replace(/((?:customer|user|lum-customer)-[^:@]+)/i, `$1-sessid-${sid}-sesstime-10`);
  }
  return proxyUrl;
}

const MAX_DEAD_PROXY_URLS = 100;

function markDeadProxy(proxyUrl) {
  // Rotating residential URLs are disposable: rotate them instead of remembering
  // every random session id forever.
  if (!proxyUrl || isResidentialProxyUrl(proxyUrl)) return;
  deadProxyUrls.add(proxyUrl);
  while (deadProxyUrls.size > MAX_DEAD_PROXY_URLS) {
    deadProxyUrls.delete(deadProxyUrls.values().next().value);
  }
}

const ISOLATED_HOME_PREFIX = "9router-opencode-";
const STALE_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function createIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), ISOLATED_HOME_PREFIX));
  if (process.platform === "win32") {
    fs.mkdirSync(path.join(dir, "AppData", "Roaming"), { recursive: true });
    fs.mkdirSync(path.join(dir, "AppData", "Local"), { recursive: true });
  }
  return dir;
}

function cleanupIsolatedHome(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    /* a locked profile dir is harmless; the next start prunes it */
  }
}

let staleHomesPruned = false;

function pruneStaleIsolatedHomes() {
  if (staleHomesPruned) return;
  staleHomesPruned = true;
  try {
    const tmp = os.tmpdir();
    const cutoff = Date.now() - STALE_HOME_MAX_AGE_MS;
    for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(ISOLATED_HOME_PREFIX)) continue;
      const full = path.join(tmp, entry.name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) cleanupIsolatedHome(full);
      } catch {
        /* raced with another process; ignore */
      }
    }
  } catch {
    /* best effort */
  }
}
export function stripAnsi(str) {
  return (str || "")
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\u001b\([a-zA-Z]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function extractAttemptedTool(rawText, clientTools = []) {
  if (!rawText) return null;
  const text = stripAnsi(rawText);

  const clientMap = new Map();
  for (const t of clientTools) {
    const fn = t.function || t;
    if (fn.name) clientMap.set(fn.name, fn);
  }

  // 1. JSON tool call: (optional symbol) <tool_name> <json> failed
  let toolName = "";
  let argsObj = null;

  const jsonMatch = text.match(/(?:[\u2717\u2718xX✗]|\b)\s*([a-zA-Z0-9_-]+)\s+(\{[^]*?\})\s*(?:failed|Error:)/i);
  if (jsonMatch) {
    toolName = jsonMatch[1].trim();
    try { argsObj = JSON.parse(jsonMatch[2].trim()); } catch {}
  }

  // 2. Explicit error message: No tool named "XYZ" is currently available
  if (!toolName) {
    const noToolMatch = text.match(/No tool named\s*["']?([a-zA-Z0-9_-]+)["']?/i);
    if (noToolMatch) {
      toolName = noToolMatch[1].trim();
      const argsMatch = text.match(/(\{[^]*?\})/);
      if (argsMatch) {
        try { argsObj = JSON.parse(argsMatch[1]); } catch {}
      }
    }
  }

  // 3. Fallback: command failure string
  if (!toolName) {
    const cmdMatch = text.match(/(?:[\u2717\u2718xX✗]|\b)\s*([\s\S]+?)\s*failed(?:\r?\n|\s*:)\s*Error:\s*No tool named/i)
      || text.match(/[\u2717\u2718xX✗]\s+([\s\S]+?)\s+failed/i);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();
      toolName = "execute_command";
      argsObj = { command: cmd };
    }
  }

  if (!toolName) return null;

  // Unwrap nested command if it contains another tool invocation (e.g. `run_commands {"commands":[...]}`)
  if (argsObj && typeof argsObj.command === "string") {
    const cleanedCmd = stripAnsi(argsObj.command);
    const unwrapMatch = cleanedCmd.match(/^([a-zA-Z0-9_-]+)\s*(\{[^]*\})$/);
    if (unwrapMatch) {
      try {
        toolName = unwrapMatch[1];
        argsObj = JSON.parse(unwrapMatch[2]);
      } catch {}
    }
  }

  // 1. Exact match in client tools
  if (clientMap.has(toolName)) {
    return { name: toolName, arguments: JSON.stringify(argsObj || {}) };
  }

  // 2. Command execution tool family (Oh My Pi: run_commands, Cline: execute_command, Claude Code: Bash, etc.)
  const isCommand = /^(run_commands|execute_command|bash|Bash|shell|terminal|run|cmd|sh)$/i.test(toolName);
  if (isCommand) {
    let commandStr = "";
    let commandArr = [];
    if (argsObj && Array.isArray(argsObj.commands)) {
      commandArr = argsObj.commands.map(String);
      commandStr = commandArr.join(" && ");
    } else if (argsObj && typeof argsObj.command === "string") {
      commandStr = argsObj.command;
      commandArr = [argsObj.command];
    } else if (argsObj && typeof argsObj.cmd === "string") {
      commandStr = argsObj.cmd;
      commandArr = [argsObj.cmd];
    }

    if (clientMap.has("run_commands")) {
      return { name: "run_commands", arguments: JSON.stringify({ commands: commandArr.length > 0 ? commandArr : [commandStr] }) };
    }
    if (clientMap.has("execute_command")) {
      return { name: "execute_command", arguments: JSON.stringify({ command: commandStr }) };
    }
    if (clientMap.has("Bash")) {
      return { name: "Bash", arguments: JSON.stringify({ command: commandStr }) };
    }
    if (clientMap.has("bash")) {
      return { name: "bash", arguments: JSON.stringify({ command: commandStr }) };
    }
    if (clientMap.has("shell")) {
      return { name: "shell", arguments: JSON.stringify({ cmd: commandStr }) };
    }
  }

  // 3. File reading tool family (read_files, read_file, FileRead, read, View)
  const isRead = /^(read_files|read_file|FileRead|read|View)$/i.test(toolName);
  if (isRead) {
    const pathStr = argsObj?.path || argsObj?.file_path || argsObj?.filePath || "";
    const pathArr = Array.isArray(argsObj?.paths) ? argsObj.paths : (pathStr ? [pathStr] : []);
    if (clientMap.has("read_files")) {
      return { name: "read_files", arguments: JSON.stringify({ paths: pathArr }) };
    }
    if (clientMap.has("read_file")) {
      return { name: "read_file", arguments: JSON.stringify({ path: pathStr || pathArr[0] || "" }) };
    }
    if (clientMap.has("FileRead")) {
      return { name: "FileRead", arguments: JSON.stringify({ file_path: pathStr || pathArr[0] || "" }) };
    }
    if (clientMap.has("read")) {
      return { name: "read", arguments: JSON.stringify({ path: pathStr || pathArr[0] || "" }) };
    }
  }

  // 4. File listing / search tool family (list_files, LS, search_codebase, search_files)
  const isList = /^(list_files|LS|ls|dir|glob|file_search)$/i.test(toolName);
  if (isList) {
    const pathStr = argsObj?.path || argsObj?.dir || argsObj?.directory || ".";
    if (clientMap.has("list_files")) {
      return { name: "list_files", arguments: JSON.stringify({ path: pathStr }) };
    }
    if (clientMap.has("LS")) {
      return { name: "LS", arguments: JSON.stringify({ path: pathStr }) };
    }
    if (clientMap.has("search_codebase")) {
      return { name: "search_codebase", arguments: JSON.stringify({ query: pathStr }) };
    }
  }

  return { name: toolName, arguments: JSON.stringify(argsObj || {}) };
}

async function acquireCliSlot(signal, proxyOptions) {
  const maxConcurrency = await resolveMaxConcurrentCli(proxyOptions);
  if (maxConcurrency === Infinity || currentRunningCliCount < maxConcurrency) {
    currentRunningCliCount++;
    return;
  }
  await new Promise((resolve, reject) => {
    const entry = () => resolve();
    cliWaitQueue.push(entry);
    if (signal) {
      signal.addEventListener("abort", () => {
        const idx = cliWaitQueue.indexOf(entry);
        if (idx !== -1) cliWaitQueue.splice(idx, 1);
        reject(new Error("Request aborted while queued for CLI engine"));
      }, { once: true });
    }
  });
  currentRunningCliCount++;
}

function releaseCliSlot() {
  currentRunningCliCount = Math.max(0, currentRunningCliCount - 1);
  if (cliWaitQueue.length > 0) {
    const next = cliWaitQueue.shift();
    next();
  }
}

export function getOpencodeBinaryVersion(executable) {
  if (!executable) return "";
  if (binaryVersionCache.has(executable)) return binaryVersionCache.get(executable);

  // Fast path: inspect package.json in parent directories if located in node_modules
  try {
    const dir = path.dirname(executable);
    const pkgCandidates = [
      path.join(dir, "..", "package.json"),
      path.join(dir, "package.json"),
      path.join(dir, "..", "..", "package.json"),
    ];
    for (const pkgPath of pkgCandidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@opencode/cli" || pkg.name === "opencode-ai" || pkg.name === "opencode") {
          const ver = String(pkg.version || "").trim();
          if (ver) {
            binaryVersionCache.set(executable, ver);
            return ver;
          }
        }
      }
    }
  } catch {
    /* fallback to execution */
  }

  // Slow path: probe via --version
  try {
    const v = execSync(`"${executable}" --version`, { encoding: "utf8", timeout: 2000 }).trim();
    binaryVersionCache.set(executable, v);
    return v;
  } catch {
    binaryVersionCache.set(executable, "");
    return "";
  }
}
function parseSemver(v) {
  const m = String(v || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] || "0", 10)];
}

export async function isCliExecutionAllowed(clientRawRequest) {
  // Safe by default: Host CLI execution is disabled unless explicitly enabled in Dashboard Settings
  const settings = await getOpencodeCliSettings();
  if (settings?.opencodeCliEnabled !== true) {
    return false;
  }
  if (process.env.OPENCODE_CLI_REMOTE_ALLOWED === "true") {
    return true;
  }
  const headers = clientRawRequest?.headers || {};
  const rawIp = headers["x-9r-real-ip"] || headers["x-real-ip"] || "";
  if (rawIp) {
    const isLoopback = rawIp === "127.0.0.1" || rawIp === "::1" || rawIp === "::ffff:127.0.0.1" || rawIp === "localhost";
    if (!isLoopback) {
      return false;
    }
  }
  return true;
}

export function findOpencodeBinary(forceRefresh = false) {
  if (process.env.OPENCODE_CLI_ENABLED === "false" || process.env.OPENCODE_CLI_DISABLED === "true") {
    return null;
  }
  const now = Date.now();
  if (!forceRefresh && cachedResolvedBinary && now - lastBinaryCheckTime < BINARY_CACHE_TTL_MS) {
    try {
      if (fs.existsSync(cachedResolvedBinary)) {
        return cachedResolvedBinary;
      }
    } catch {}
    cachedResolvedBinary = null;
  }
  const isWin = process.platform === "win32";
  const homeDir = os.homedir() || process.env.USERPROFILE || process.env.HOME || "";
  // 1. Explicit environment variable override
  if (process.env.OPENCODE_BIN) {
    try {
      if (fs.existsSync(process.env.OPENCODE_BIN)) {
        cachedResolvedBinary = process.env.OPENCODE_BIN;
        lastBinaryCheckTime = now;
        return process.env.OPENCODE_BIN;
      }
    } catch {}
  }

  // 2. Candidate collection for all platforms (npm, bun, pnpm, yarn, nvm, fnm, volta, asdf, homebrew, linux distro paths)
  const candidateList = [];

  // Standalone @opencode/cli package binaries (npm / bun / pnpm / yarn global install)
  if (isWin) {
    if (homeDir) {
      candidateList.push(
        path.join(homeDir, ".bun", "install", "global", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
        path.join(homeDir, ".bun", "bin", "opencode.exe"),
        path.join(homeDir, ".yarn", "bin", "opencode.cmd"),
        path.join(homeDir, ".yarn", "bin", "opencode.exe")
      );
    }
    const appData = process.env.APPDATA || "";
    if (appData) {
      candidateList.push(
        path.join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
        path.join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.cmd"),
        path.join(appData, "npm", "opencode.cmd"),
        path.join(appData, "npm", "opencode.exe")
      );
    }
    const localAppData = process.env.LOCALAPPDATA || "";
    if (localAppData) {
      candidateList.push(
        path.join(localAppData, "Programs", "opencode", "opencode.exe"),
        path.join(localAppData, "pnpm", "opencode.cmd"),
        path.join(localAppData, "pnpm", "opencode.exe"),
        path.join(localAppData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      );
    }
  } else {
    // Linux / macOS / Docker candidates
    candidateList.push(
      "/usr/local/bin/opencode",
      "/usr/bin/opencode",
      "/opt/homebrew/bin/opencode",
      "/root/bin/opencode",
      "/tmp/oc-cli/package/bin/opencode"
    );
    if (homeDir) {
      candidateList.push(
        path.join(homeDir, ".local", "bin", "opencode"),
        path.join(homeDir, ".bun", "bin", "opencode"),
        path.join(homeDir, ".bun", "install", "global", "node_modules", "@opencode", "cli", "bin", "opencode"),
        path.join(homeDir, ".npm-global", "bin", "opencode"),
        path.join(homeDir, ".npm-global", "lib", "node_modules", "@opencode", "cli", "bin", "opencode"),
        path.join(homeDir, ".pnpm", "bin", "opencode"),
        path.join(homeDir, "Library", "pnpm", "opencode"),
        path.join(homeDir, ".yarn", "bin", "opencode"),
        path.join(homeDir, ".volta", "bin", "opencode"),
        path.join(homeDir, ".asdf", "shims", "opencode"),
        path.join(homeDir, ".local", "share", "fnm", "current", "bin", "opencode"),
        "/usr/local/lib/node_modules/@opencode/cli/bin/opencode",
        "/usr/lib/node_modules/@opencode/cli/bin/opencode"
      );
      // Check nvm versions if present
      const nvmNodeDir = path.join(homeDir, ".nvm", "versions", "node");
      try {
        if (fs.existsSync(nvmNodeDir)) {
          const versions = fs.readdirSync(nvmNodeDir).sort().reverse();
          for (const ver of versions.slice(0, 3)) {
            candidateList.push(path.join(nvmNodeDir, ver, "bin", "opencode"));
          }
        }
      } catch {}
    }
  }

  // 3. System PATH probe via which / where
  try {
    const cmd = isWin ? "where opencode 2>nul" : "which opencode 2>/dev/null";
    const lines = execSync(cmd, { encoding: "utf8", timeout: 2000 })
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const p of lines) {
      if (isWin) {
        if (/\.(cmd|exe|bat)$/i.test(p)) candidateList.push(p);
        else {
          candidateList.push(`${p}.cmd`, `${p}.exe`, p);
        }
      } else {
        candidateList.push(p);
      }
    }
  } catch {
    /* ignore */
  }

  // 4. Local project node_modules fallback (npm / bun local install)
  candidateList.push(
    path.join(process.cwd(), "node_modules", ".bin", isWin ? "opencode.cmd" : "opencode"),
    path.join(process.cwd(), "node_modules", ".bin", isWin ? "opencode.exe" : "opencode"),
    path.join(process.cwd(), "node_modules", "@opencode", "cli", "bin", isWin ? "opencode.exe" : "opencode")
  );

  // Filter existing binaries
  const existing = [];
  const seen = new Set();
  for (const bin of candidateList) {
    if (!bin || seen.has(bin)) continue;
    seen.add(bin);
    try {
      if (fs.existsSync(bin)) existing.push(bin);
    } catch {}
  }

  if (existing.length === 0) return null;

  // Rank candidates: sort by semver descending so the latest available engine is always chosen
  // (e.g. @opencode/cli 2.1.x > 2.0.x > legacy opencode-ai 1.x).
  // If versions are identical, prefer native .exe over .cmd/.bat for direct spawn without cmd.exe.
  const ranked = existing.map((bin) => ({
    bin,
    ver: getOpencodeBinaryVersion(bin),
  }));

  ranked.sort((a, b) => {
    const [a1, a2, a3] = parseSemver(a.ver);
    const [b1, b2, b3] = parseSemver(b.ver);
    if (a1 !== b1) return b1 - a1;
    if (a2 !== b2) return b2 - a2;
    if (a3 !== b3) return b3 - a3;
    const aIsExe = /\.exe$/i.test(a.bin);
    const bIsExe = /\.exe$/i.test(b.bin);
    if (aIsExe && !bIsExe) return -1;
    if (!aIsExe && bIsExe) return 1;
    return 0;
  });

  const selectedBin = ranked[0]?.bin || existing[0];
  lastBinaryCheckTime = now;
  return selectedBin;
}

export function formatOpencodeCliPrompt(body) {
  if (!body) return "";

  const systemParts = [];

  // Add tool definitions to system prompt if tools are present
  if (hasTools(body)) {
    const toolPrompt = buildToolSystemPrompt(body.tools);
    if (toolPrompt) systemParts.push(toolPrompt);
  }

  // 1. Direct system field (Anthropic or custom)
  if (typeof body.system === "string" && body.system.trim()) {
    systemParts.push(body.system.trim());
  } else if (Array.isArray(body.system)) {
    const s = body.system
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (s) systemParts.push(s);
  }

  // 2. System and dialog messages from body.messages
  const dialogMsgs = [];
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg) continue;
      const role = String(msg.role || "").toLowerCase();
      const content = msg.content;
      const text = typeof content === "string"
        ? content.trim()
        : Array.isArray(content)
          ? content
              .map((c) => (typeof c === "string" ? c : c?.text || ""))
              .filter(Boolean)
              .join("\n")
              .trim()
          : "";

      if (role === "system" || role === "developer") {
        if (text) systemParts.push(text);
      } else if (role === "user") {
        if (text) dialogMsgs.push({ role: "user", text });
      } else if (role === "assistant") {
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          const tcLines = [];
          if (text) tcLines.push(text);
          for (const tc of msg.tool_calls) {
            const fn = tc.function || tc;
            let args = fn.arguments;
            if (typeof args !== "string") {
              try { args = JSON.stringify(args ?? {}); } catch { args = "{}"; }
            }
            tcLines.push(`<<TOOL_CALL>> {"name":"${fn.name || ""}","arguments":${args || "{}"}} <<TOOL_CALL>>`);
          }
          dialogMsgs.push({ role: "assistant", text: tcLines.join("\n") });
        } else if (text) {
          dialogMsgs.push({ role: "assistant", text });
        }
      } else if (role === "tool") {
        dialogMsgs.push({ role: "user", text: `<<TOOL_RESULT>> ${msg.name || "tool"}: ${text || ""} <<TOOL_RESULT>>` });
      }
    }
  }

  // If there are no system parts and only 1 user message, return it directly
  if (systemParts.length === 0 && dialogMsgs.length === 1 && dialogMsgs[0].role === "user") {
    return dialogMsgs[0].text;
  }

  const promptSections = [];

  // Add system instructions section
  if (systemParts.length > 0) {
    promptSections.push(`[System Instructions]\n${systemParts.join("\n\n")}`);
  }

  // If multi-turn conversation, format earlier history
  if (dialogMsgs.length > 1) {
    const earlierTurns = dialogMsgs.slice(0, -1);
    const historyText = earlierTurns
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)
      .join("\n\n");
    promptSections.push(`[Conversation History]\n${historyText}`);

    const lastMsg = dialogMsgs[dialogMsgs.length - 1];
    promptSections.push(`User: ${lastMsg.text}`);
  } else {
    // Single user turn with system instructions
    promptSections.push(`User: ${dialogMsgs[0].text}`);
  }

  return promptSections.join("\n\n").trim();
}

export function resolveWorkspaceCwd(body) {
  const candidates = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) candidates.push(v.trim());
  };
  push(body?.cwd);
  push(body?.working_directory);
  push(body?.workdir);
  push(body?.workspace);
  push(body?.metadata?.cwd);
  push(body?.metadata?.working_directory);

  const scanText = (text) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(/<cwd>\s*([^<]+?)\s*<\/cwd>/gi)) push(m[1]);
    for (const m of text.matchAll(/current working directory:\s*['"]?([^'"\r\n]+?)['"]?[.\s]/gi)) push(m[1]);
    for (const m of text.matchAll(/(?:Current working directory|Working directory|cwd|Workspace):\s*['"]?([^'"\r\n]+?)['"]?[.\r\n]/gi)) {
      push(m[1].trim());
    }
  };
  const scanMessages = (msgs) => {
    if (!Array.isArray(msgs)) return;
    for (const msg of msgs) {
      if (!msg) continue;
      if (typeof msg.content === "string") scanText(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (typeof p === "string") scanText(p);
          else if (p && typeof p === "object") {
            scanText(p.text || p.input_text || p.content);
          }
        }
      }
    }
  };
  scanMessages(body?.messages);
  scanMessages(body?.input);
  if (typeof body?.system === "string") scanText(body.system);

  // 1. If client provided a valid local directory that exists on this machine, use it
  for (const c of candidates) {
    try {
      if (path.isAbsolute(c) && fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Remote client or path not on server: NEVER fall back to process.cwd() (which would leak 9router server files/secrets!)
  // Fall back to an isolated, empty sandbox directory in os.tmpdir()
  const sandboxDir = path.join(os.tmpdir(), "9router-agent-sandbox");
  try {
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true });
    }
    return sandboxDir;
  } catch {
    return os.tmpdir();
  }
}
export async function executeOpencodeCli({
  opencodeBin,
  targetModel,
  promptText,
  body,
  proxyOptions,
  signal,
  log,
  rawModel,
  providerTag = "OPENCODE",
}) {
  const env = { ...process.env };
  const isWin = process.platform === "win32";
  const isolatedHome = path.join(os.tmpdir(), "9router-opencode-home");
  try {
    if (!fs.existsSync(isolatedHome)) {
      fs.mkdirSync(isolatedHome, { recursive: true });
    }
  } catch {}
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  if (isWin) {
    env.APPDATA = path.join(isolatedHome, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(isolatedHome, "AppData", "Local");
  }
  let executable = opencodeBin;
  if (isWin && !/\.(cmd|exe|bat)$/i.test(executable)) {
    if (fs.existsSync(`${executable}.cmd`)) {
      executable = `${executable}.cmd`;
    } else if (fs.existsSync(`${executable}.exe`)) {
      executable = `${executable}.exe`;
    } else if (fs.existsSync(`${executable}.bat`)) {
      executable = `${executable}.bat`;
    }
  }

  const responseId = `chatcmpl-oc-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const sseStream = new ReadableStream({
    async start(controller) {
      const emit = (str) => {
        try {
          controller.enqueue(new TextEncoder().encode(str));
        } catch {
          /* fail open if stream closed */
        }
      };

      // Flush immediate leading role chunk so client gets HTTP 200 + TTFT in < 1ms
      emit(
        `data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`
      );

      let finalResult = null;
      const maxAttempts = 3;
      let proxyBypassed = false;

      await acquireCliSlot(signal, proxyOptions);
      try {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const configuredProxy = proxyOptions?.connectionProxyEnabled ? proxyOptions.connectionProxyUrl : null;
    let candidateProxy = configuredProxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
    let currentProxyUrl = candidateProxy;
    const isResidential = currentProxyUrl && (/-s(?:ess)?id-\d+/i.test(currentProxyUrl) || /pr\.oxylabs\.io/i.test(currentProxyUrl));
    if (isResidential) {
      const randSid = Math.floor(1000000000 + Math.random() * 9000000000);
      if (/-s(?:ess)?id-\d+/i.test(currentProxyUrl)) {
        currentProxyUrl = currentProxyUrl.replace(/-s(?:ess)?id-\d+/i, (m) => m.replace(/\d+$/, String(randSid)));
      } else {
        currentProxyUrl = currentProxyUrl.replace(/(customer-[^:@]+)/i, `$1-sessid-${randSid}-sesstime-10`);
      }
      proxyBypassed = false;
    } else if (candidateProxy && deadProxyUrls.has(candidateProxy)) {
      currentProxyUrl = null;
    }
    const runEnv = { ...env };
    const freshHome = path.join(os.tmpdir(), "9router-opencode-" + Math.floor(100000 + Math.random() * 900000));
    try { fs.mkdirSync(freshHome, { recursive: true }); } catch {}
    runEnv.HOME = freshHome;
    runEnv.USERPROFILE = freshHome;
    if (isWin) {
      runEnv.APPDATA = path.join(freshHome, "AppData", "Roaming");
      runEnv.LOCALAPPDATA = path.join(freshHome, "AppData", "Local");
    }
    if (currentProxyUrl) {
      runEnv.HTTP_PROXY = currentProxyUrl;
      runEnv.HTTPS_PROXY = currentProxyUrl;
      runEnv.http_proxy = currentProxyUrl;
      runEnv.https_proxy = currentProxyUrl;
      runEnv.ALL_PROXY = currentProxyUrl;
      runEnv.all_proxy = currentProxyUrl;
      runEnv.NO_PROXY = "127.0.0.1,localhost,::1";
      runEnv.no_proxy = "127.0.0.1,localhost,::1";
      if (attempt === 1) {
        const masked = currentProxyUrl.replace(/:[^:@]+@/, ":***@");
        log?.info?.(providerTag, `CLI proxy active: ${masked}`);
      } else {
        log?.info?.(providerTag, `CLI attempt ${attempt} using proxy: ${currentProxyUrl ? "active" : "bypassed (direct)"}`);
      }
    } else if (attempt > 1) {
      log?.info?.(providerTag, `CLI attempt ${attempt} running via direct host network`);
    }
    try {
      const version = getOpencodeBinaryVersion(executable);
      const isV2 = /^v?[2-9]\./i.test(version) || version.includes("2.");
      const cliArgs = ["run"];
      if (isV2) {
        cliArgs.push("--standalone");
      }
      cliArgs.push("--model", targetModel, "--format", "default");

      finalResult = await new Promise((resolve, reject) => {
        let childProcess;
        try {
          childProcess = spawn(
            executable,
            cliArgs,
            {
              cwd: resolveWorkspaceCwd(body),
              env: runEnv,
              stdio: ["pipe", "pipe", "pipe"],
              shell: isWin && !/\.exe$/i.test(executable),
              windowsHide: true,
            }
          );
        } catch (spawnErr) {
          return reject(spawnErr);
        }

        if (childProcess.stdin) {
          try {
            childProcess.stdin.write(promptText || "");
            childProcess.stdin.end();
          } catch {
            /* ignore if closed early */
          }
        }
        let stdoutText = "";
        let stderrText = "";
        let isResolved = false;

        const doResolve = (val) => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timer);
          activeCliProcesses.delete(childProcess);
          terminateCliProcess(childProcess);
          resolve(val);
        };

        const checkForAttemptedTool = () => {
          if (isResolved) return;
          const combined = `${stderrText} ${stdoutText}`;
          const clientTools = Array.isArray(body?.tools) ? body.tools : [];
          const attempted = extractAttemptedTool(combined, clientTools);
          if (attempted) {
            log?.info?.(providerTag, `Fast-intercepted model tool [${attempted.name}] for client agent: ${attempted.arguments.slice(0, 100)}`);
            const synthesizedToolCall = `<<TOOL_CALL>> {"name":${JSON.stringify(attempted.name)},"arguments":${attempted.arguments}} <<TOOL_CALL>>`;
            doResolve({ success: true, text: synthesizedToolCall });
          }
        };

        childProcess.stdout.on("data", (chunk) => {
          stdoutText += chunk.toString("utf-8");
          checkForAttemptedTool();
        });

        childProcess.stderr.on("data", (chunk) => {
          stderrText += chunk.toString("utf-8");
          checkForAttemptedTool();
        });

        activeCliProcesses.add(childProcess);

        // Sane timeout scaled with prompt length up to 360s for massive 150k+ token prompts
        const promptLen = promptText?.length || 0;
        const CLI_TIMEOUT_MS = Math.max(90000, Math.min(360000, 60000 + Math.floor(promptLen / 200) * 1000));
        const timer = setTimeout(() => {
          if (currentProxyUrl) {
            deadProxyUrls.add(currentProxyUrl);
            proxyBypassed = true;
          }
          terminateCliProcess(childProcess);
          reject(new Error(`CLI attempt timed out after ${CLI_TIMEOUT_MS / 1000}s (${currentProxyUrl ? 'proxy dead, bypassing to direct host' : 'direct connection timed out'})`));
        }, CLI_TIMEOUT_MS);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            terminateCliProcess(childProcess);
          }, { once: true });
        }

        childProcess.on("error", (err) => {
          clearTimeout(timer);
          activeCliProcesses.delete(childProcess);
          if (currentProxyUrl) proxyBypassed = true;
          reject(err);
        });

        childProcess.on("close", (code) => {
          if (isResolved) return;
          clearTimeout(timer);
          activeCliProcesses.delete(childProcess);

          const combined = `${stderrText} ${stdoutText}`.trim();
          const clientTools = Array.isArray(body?.tools) ? body.tools : [];

          // 1. If OpenCode CLI attempted a tool execution (e.g. run_commands, execute_command, bash, read_file)
          // and failed locally, bridge the tool call back to the client agent (Cline / omp) so the client executes it!
          const attempted = extractAttemptedTool(combined, clientTools);
          if (attempted) {
            log?.info?.(providerTag, `Bridged tool [${attempted.name}] to client agent: ${attempted.arguments.slice(0, 100)}`);
            const synthesizedToolCall = `<<TOOL_CALL>> {"name":${JSON.stringify(attempted.name)},"arguments":${attempted.arguments}} <<TOOL_CALL>>`;
            return doResolve({ success: true, text: synthesizedToolCall });
          }

          // 2. Check if model outputted an internal sandbox refusal ("This session only exposes the opencode tool namespace", "no shell tool", etc.)
          const isRefusalDueToSandbox = /This session only exposes the opencode tool namespace|no shell tool|no file read\/write tool|I literally cannot read|Enable the shell \+ edit tools/i.test(stdoutText);
          if (isRefusalDueToSandbox && clientTools.length > 0) {
            log?.warn?.(providerTag, `Model issued sandbox refusal; falling back to client workspace inspection tool`);
            const runCmdTool = clientTools.find((t) => (t.function?.name || t.name) === "run_commands");
            const execCmdTool = clientTools.find((t) => (t.function?.name || t.name) === "execute_command");
            const listFilesTool = clientTools.find((t) => (t.function?.name || t.name) === "list_files");
            const mentionedCmd = stdoutText.match(/`([^`\r\n]{2,120})`/)?.[1]
              || stdoutText.match(/(?:run|command|execute):\s*([^\r\n]{2,120})/i)?.[1]
              || "";

            if (listFilesTool) {
              const synthesizedToolCall = `<<TOOL_CALL>> {"name":"${listFilesTool.function?.name || listFilesTool.name}","arguments":{"path":"."}} <<TOOL_CALL>>`;
              return doResolve({ success: true, text: synthesizedToolCall });
            } else if (runCmdTool) {
              const cmd = mentionedCmd || "git status --short";
              const synthesizedToolCall = `<<TOOL_CALL>> {"name":"${runCmdTool.function?.name || runCmdTool.name}","arguments":{"commands":[${JSON.stringify(cmd)}]}} <<TOOL_CALL>>`;
              return doResolve({ success: true, text: synthesizedToolCall });
            } else if (execCmdTool) {
              const cmd = mentionedCmd || "git status --short";
              const synthesizedToolCall = `<<TOOL_CALL>> {"name":"${execCmdTool.function?.name || execCmdTool.name}","arguments":{"command":${JSON.stringify(cmd)}}} <<TOOL_CALL>>`;
              return doResolve({ success: true, text: synthesizedToolCall });
            }
          }

          // 3. Normal successful execution
          if (code === 0 && stdoutText.trim()) {
            return doResolve({ success: true, text: stdoutText.trim() });
          }

          // 4. Proxy error or rate limit checks
          const isProxyErrorOrRateLimit = /tunnel:\s*(400|403|407|502|503|504)|tunnel\s*failed|ECONNRESET|ETIMEDOUT|407\s*Proxy|UnexpectedStatus:\s*(403|429)|FreeUsageLimitError|Free usage limit reached/i.test(combined);

          if (isProxyErrorOrRateLimit) {
            if (currentProxyUrl) {
              deadProxyUrls.add(currentProxyUrl);
              if (/-s(?:ess)?id-\d+/i.test(currentProxyUrl)) {
                // Rotating residential proxy: DO NOT bypass! Generate a fresh residential session IP!
                const newSid = Math.floor(1000000000 + Math.random() * 9000000000);
                candidateProxy = candidateProxy.replace(/-s(?:ess)?id-\d+/i, (m) => m.replace(/\d+$/, String(newSid)));
                proxyBypassed = false;
                log?.warn?.(providerTag, `Residential proxy IP rate-limited or error; auto-switched to fresh residential session ID: ${newSid}`);
              } else {
                proxyBypassed = true;
              }
            }
            return reject(new Error(`Proxy rejected connection (code ${code}): ${combined.slice(0, 150)}`));
          }

          if (code !== 0 && !stdoutText.trim()) {
            if (currentProxyUrl && !/-s(?:ess)?id-\d+/i.test(currentProxyUrl)) {
              proxyBypassed = true;
            }
            return reject(new Error(`CLI exited with code ${code}: ${combined.slice(0, 150)}`));
          }

          doResolve({ success: true, text: stdoutText.trim() });
        });
      });

      if (finalResult?.success && finalResult.text) {
        break;
      }
    } catch (err) {
      log?.warn?.(providerTag, `CLI attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      if (attempt === maxAttempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  } finally {
    releaseCliSlot();
  }

      const responseText = (finalResult?.text || "").trim();
      if (!finalResult?.success || !responseText) {
        emit(
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: rawModel,
            choices: [{ index: 0, delta: { content: "\n[Error: OpenCode CLI produced no output text]" }, finish_reason: "stop" }],
          })}\n\n`
        );
        emit("data: [DONE]\n\n");
        controller.close();
        return;
      }

      const clientHasTools = hasTools(body);
      const parsedTools = clientHasTools ? parseToolCallReply(responseText) : null;
      const isToolCall = Boolean(parsedTools?.calls && parsedTools.calls.length > 0);

      if (isToolCall) {
        // Emit any leading text content
        if (parsedTools.content) {
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: rawModel,
              choices: [{ index: 0, delta: { content: parsedTools.content }, finish_reason: null }],
            })}\n\n`
          );
        }

        // Emit tool call deltas
        parsedTools.calls.forEach((call, idx) => {
          const callId = generateToolCallId();
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: rawModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: idx,
                        id: callId,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {}),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          );
        });

        // Finish reason tool_calls
        emit(
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: rawModel,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`
        );
      } else {
        // Normal text chunk
        if (responseText) {
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: rawModel,
              choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
            })}\n\n`
          );
        }

        // Stop chunk
        emit(
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: rawModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`
        );
      }

      emit("data: [DONE]\n\n");
      controller.close();
    },
  });
  return {
    response: new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
    url: "opencode://cli/run",
    headers: {},
    transformedBody: { model: targetModel, prompt: promptText.slice(0, 100) },
  };
}
