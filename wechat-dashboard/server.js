#!/usr/bin/env node
/**
 * WeChat Agent Dashboard — PC + mobile remote UI
 * Categories, transcripts, ChatGPT-style chat (proxies OpenClaw gateway)
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const {
  loadAccessPolicy,
  saveAccessPolicy,
  loadBridgeDisplayNames,
  loadWeChatDisplayNames,
  buildExtraNames,
  resolveCategoryForTalker,
  getAutoReplySettings,
  shouldAutoReplyForTalker,
  resolveReplyTierForTalker,
  getStoredReplyTier,
  isWhitelistedForAutoReply,
  REPLY_TIERS,
  REPLY_TIER_LABELS,
  listWhitelistedTalkers,
  displayNameForTalker,
  isHiddenFromGroupList,
} = require("../wechat-privacy");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const {
  ALLOWED_EXT,
  parseMultipart,
  collectBodyBuffer,
  safeExt,
  triggerMemoryReindex,
  ingestUploadedFile,
  listUploads,
} = require("./knowledge-upload");
const { deliverFile: deliverAgentFile } = require("../wechat-send-file");

const WORKSPACE =
  process.env.WECHAT_WORKSPACE ||
  path.join(process.env.HOME || "/home/su", ".openclaw/workspace-wechat");

const INGEST_UPLOAD_SCRIPT = path.join(WORKSPACE, "skills/wechat-knowledge/ingest_upload.py");
const KNOWLEDGE_SEARCH_SCRIPT = path.join(WORKSPACE, "skills/wechat-knowledge/search.py");
const GEMINI_FALLBACK_SCRIPT = path.join(WORKSPACE, "skills/wechat-knowledge/fallback_answer.py");
const UPLOAD_QUERY_SCRIPT = path.join(WORKSPACE, "skills/wechat-knowledge/query_uploads.py");
const TODO_QUERY_SCRIPT = path.join(WORKSPACE, "skills/wechat-calendar/query_todos.py");
const CALENDAR_DASHBOARD_SCRIPT = path.join(WORKSPACE, "skills/wechat-calendar/calendar_dashboard.py");
const TRAINING_LOG_SCRIPT = path.join(WORKSPACE, "skills/wechat-calendar/training_log.py");
const PEOPLE_MEMORY_SCRIPT = path.join(__dirname, "../scripts/wechat-people-memory.py");
const PEOPLE_PROFILE_STORE = path.join(WORKSPACE, "memory/people/profiles.json");
const MEDIA_MANIFEST_PATH = path.join(WORKSPACE, "media/manifest.jsonl");
const POSTPROCESS_JOB_FILE = path.join(WORKSPACE, "state/wechat-postprocess-jobs.json");
const XWECHAT_FILE_ROOTS = (process.env.XWECHAT_FILE_ROOTS ||
  "/mnt/c/Users/ZEYU HE/OneDrive/文档/xwechat_files")
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean);
const RECENT_FILE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
const RECENT_FILE_CACHE_MS = Number(process.env.DASHBOARD_RECENT_FILE_CACHE_MS || "30000");
let recentWechatFileCache = { at: 0, rows: [] };

const SYNC_SCRIPT = path.join(__dirname, "../scripts/sync-wechat-display-names.js");
const DISPLAY_NAMES_PATH = path.join(WORKSPACE, "privacy/display_names.json");
const SYNC_MAX_AGE_MS = Number(process.env.DASHBOARD_NAME_SYNC_MS || String(3600 * 1000));

const LISTEN_HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.DASHBOARD_PORT || "18800");
const GATEWAY = process.env.OPENCLAW_GATEWAY || "http://127.0.0.1:18789";
const GATEWAY_TOKEN =
  process.env.OPENCLAW_GATEWAY_TOKEN || "f8d1aadd0ea26bce62fbc3562fd3a10f7a4442526c2973db";
const DASHBOARD_PASSWORD =
  process.env.WECHAT_DASHBOARD_PASSWORD || process.env.WECHAT_INGEST_TOKEN || GATEWAY_TOKEN;
const AGENT_MODEL = process.env.WECHAT_AGENT_MODEL || "openclaw/wechat-twin";
const REMOTE_AGENT_MODEL =
  process.env.WECHAT_REMOTE_AGENT_MODEL || "openclaw/wechat-remote";
const SESSION_SECRET = process.env.WECHBOARD_SESSION_SECRET || DASHBOARD_PASSWORD;
const GATEWAY_TIMEOUT_MS = Number(process.env.WECHAT_GATEWAY_TIMEOUT_MS || "1160000");
const CHAT_HISTORY_LIMIT = Math.max(4, Number(process.env.WECHAT_CHAT_HISTORY_LIMIT || "12"));
const CHAT_JOB_FILE = path.join(WORKSPACE, "state", "dashboard-chat-jobs.json");
const chatJobs = new Map();
let chatJobWorkerRunning = false;
let calendarPullJob = null;
let calendarPullResult = null;

// Keep ordinary dashboard conversation on the twin, but route an explicit
// computer-side repair/query to the agent that has the execution tools.
const EXECUTION_INTENT_RE = /(?:修复|解决|处理|改好|修一下|排查并(?:修|解决|处理)|检查.{0,20}(?:修|解决|处理)|部署|重启(?:服务|电脑|网关)?|执行|调用|安装|更新|回滚|改代码|修改配置|启动服务|停止服务|打开(?:微信|高德|浏览器|文件|程序)|发送(?:消息|文件)|查询.{0,12}(?:路程|路线|耗时|多久到)|路程(?:时间|多久)|路线(?:时间|耗时)|驾车(?:时间|多久)|开车(?:多久|要多长)|导航|高德|skillerror|技能错误|api(?:有问题|错误|失败)|接口(?:有问题|错误|失败)|调用失败|查询失败)/i;

function selectDashboardAgentModel(text) {
  const value = String(text || "").trim();
  return value && EXECUTION_INTENT_RE.test(value) ? REMOTE_AGENT_MODEL : AGENT_MODEL;
}

function executionDirective(text) {
  if (selectDashboardAgentModel(text) !== REMOTE_AGENT_MODEL) return "";
  return "\n\n【电脑端执行请求】这是用户已授权的电脑端检查/修复请求。请实际读取相关日志、配置和 Skill，并调用可用工具完成诊断与修复；不要只回复‘已记录’或‘稍后处理’，也不要把计划说成已完成。路程/高德问题优先使用电脑端高德 Web Service 或现有工具，不要错误转成手机前台点击。";
}

const ACCESS_POLICY_PATH = path.join(WORKSPACE, "privacy/access_policy.json");
const TRANSCRIPT_DIR = path.join(WORKSPACE, "exports/live");
const CALENDAR_STATE = path.join(WORKSPACE, "calendar/distiller_state.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const BRIDGE_CONFIG_CANDIDATES = [
  path.join(__dirname, "../wechat-pc-bridge.wsl.config.json"),
  path.join(__dirname, "../wechat-pc-bridge.config.json"),
];

function bridgeConfigPath() {
  for (const p of BRIDGE_CONFIG_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return BRIDGE_CONFIG_CANDIDATES[0];
}

function loadBridgeConfig() {
  return readJson(bridgeConfigPath(), { group_display_names: {} });
}

function saveBridgeConfig(cfg) {
  writeJson(bridgeConfigPath(), cfg);
}

const CATEGORY_POOL = {
  广告: "spam",
  工作: "work",
  私人: "private",
  爱好: "private",
};

const DEFAULT_CATEGORIES = {
  preset: ["广告", "工作", "爱好", "私人"],
  custom: ["补课"],
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const ACTIONABLE_MEDIA_STATUSES = new Set(["queued", "running", "ready", "captured_unbound"]);

// The postprocess job store also contains text-only calendar and memory
// messages. They share the same file, but must never be shown as image queue
// work. Require an explicit media marker before a job can affect this panel.
const MEDIA_EVENT_FIELDS = [
  "media_kind", "media_message_key", "media_path", "media_file",
  "media_canonical_file", "media_status", "media_file_sha256",
  "media_full_sha256", "media_thumbnail_sha256", "media_middle_sha256",
  "media_local_id", "media_server_id", "media_create_time",
  "media_method", "media_note", "media_hd_pending", "media_hd_requested",
  "media_recovered", "media_message_ts_ms", "media_file_name",
  "file", "canonical_file", "path_hint",
];

function isMediaPostprocessJob(job) {
  const event = job?.event || job || {};
  if (MEDIA_EVENT_FIELDS.some((field) => {
    const value = event[field] ?? job?.[field];
    return value !== undefined && value !== null && String(value) !== "";
  })) return true;
  return /\[(?:图片|文件|视频|语音|音乐)\]/.test(String(event.content || ""));
}

function isAwaitingEvidence(job) {
  if (String(job?.evidence_status || "") !== "awaiting-evidence") return false;
  const resultReasons = [
    job?.result?.calendar?.result?.reason,
    job?.result?.vision_calendar?.result?.reason,
    job?.result?.calendar?.reason,
    job?.result?.vision_calendar?.reason,
  ].map((value) => String(value || ""));
  return String(job?.last_error || "") === "online-clarification-suppressed" ||
    resultReasons.includes("online-clarification-required");
}

function mediaBusinessStatus(row) {
  // The postprocess job file is the source of truth for work that can still
  // execute. Manifest rows are an append-only audit log and contain many
  // historical manual_review/missing/repair_required records. Counting those
  // as live retries made the dashboard report 316 while only 73 jobs existed.
  const rawStatus = String(row?.status || "");
  if (["done", "filtered", "discarded", "succeeded"].includes(rawStatus)) return "success";
  if (["queued", "running", "ready", "captured_unbound"].includes(rawStatus)) return "new";
  // A row that has explicitly entered source resolution is live work. Keep
  // the initial registration visible as new, and retain exhausted resolution
  // attempts as retry until the matching postprocess job reconciles it.
  if (row?.attachment_failure_class === "attachment_unresolved") {
    const attempts = Number(row?.attachment_retry_attempts || 0);
    if (row?.attachment_failure_reason === "source-resolution-not-started" && attempts === 0) {
      return "new";
    }
    if (row?.vision_state === "attachment_resolve_failed" || attempts > 0) {
      return "retry";
    }
  }
  // pending/retry/manual_review/missing/repair_required are retained for audit;
  // they are counted only when a matching postprocess job claims them.
  return null;
}

function mediaBacklogCounts(rows) {
  // Failed legacy rows remain retries even when the worker cannot claim them.
  let newBacklog = 0;
  let retryBacklog = 0;
  for (const row of rows) {
    const businessStatus = mediaBusinessStatus(row);
    if (businessStatus === "new") newBacklog += 1;
    if (businessStatus === "retry") retryBacklog += 1;
  }
  return { newBacklog, retryBacklog };
}
function readPostprocessJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(POSTPROCESS_JOB_FILE, "utf8"));
    return Array.isArray(raw?.jobs) ? raw.jobs : [];
  } catch {
    return [];
  }
}

function queueIdentityKeys(row) {
  const event = row?.event || row || {};
  const keys = new Set();
  // Manifest id and event media_message_key describe the same message.
  for (const value of [event.media_message_key, event.message_key,
    !row?.event && String(row?.id || "").includes("|") ? row.id : null]) {
    if (value) keys.add("message:" + String(value));
  }
  const talker = String(event.talker || "");
  const rawTime = Number(event.ts || event.message_ts_ms || event.media_message_ts_ms || 0);
  const stamp = rawTime > 1e12 ? Math.floor(rawTime / 1000) : rawTime;
  // Local IDs are neither global nor meaningful when zero. Scope fallbacks
  // to the conversation and message time so unrelated failures stay visible.
  if (!talker || !Number.isFinite(stamp) || stamp <= 0) return keys;
  for (const key of ["media_local_id", "local_id"]) {
    const value = event[key] ?? row?.[key];
    if (Number(value) > 0) keys.add("local:" + JSON.stringify([talker, stamp, String(value)]));
  }
  for (const key of ["media_file_sha256", "media_full_sha256", "media_thumbnail_sha256", "file_sha"]) {
    const value = event[key] ?? row?.[key];
    if (value) keys.add("sha:" + JSON.stringify([talker, stamp, String(value)]));
  }
  return keys;
}

function canonicalQueueCounts(mediaRows, postprocessJobs = readPostprocessJobs()) {
  const counts = { new: 0, retry: 0, success: 0 };
  const claimedMedia = new Map();
  let runningPostprocess = null;
  let runnable = 0;
  for (const job of postprocessJobs) {
    if (!isMediaPostprocessJob(job)) continue;
    const shared = { state: null };
    for (const key of queueIdentityKeys(job)) {
      if (!claimedMedia.has(key)) claimedMedia.set(key, []);
      claimedMedia.get(key).push(shared);
    }
    const status = String(job.status || "");
    const attempts = Number(job.attempts || 0);
    const memoryStatus = String(job.memory_status || "");
    const memoryAttempts = Number(job.memory_attempts || 0);
    const memoryPending = memoryStatus && memoryStatus !== "succeeded";
    const memoryRetry = memoryPending && (Boolean(job.memory_error) ||
      !["queued", "running"].includes(memoryStatus) ||
      memoryAttempts > (memoryStatus === "running" ? 1 : 0));
    if (isAwaitingEvidence(job)) continue;
    // Completion of the calendar phase does not complete people-memory.
    // Count the message once, retaining exhausted/deferred work as retry.
    if (status === "succeeded" && memoryPending) {
      shared.state = memoryRetry ? "retry" : "new";
      counts[shared.state] += 1;
    } else if (status === "succeeded") {
      shared.state = "success";
      counts.success += 1;
    } else if (status === "retry" || job.repair_previous_status === "retry" || job.retry_exhausted || attempts > 0 && status === "queued") {
      shared.state = "retry";
      counts.retry += 1;
    } else if (status === "queued" || status === "running") {
      shared.state = "new";
      counts.new += 1;
    }
    // A terminal retry remains counted above, but it is not claimable by the
    // scheduler. Keep this separate so the UI cannot call it “waiting”.
    if (status === "running") {
      runningPostprocess = job;
      runnable += 1;
    } else if ((status === "queued" || status === "retry") &&
        job.repair_execution?.pending === true &&
        !job.repair_execution?.started_at && Number(job.repair_execution?.attempts || 0) === 0) {
      // A verified repair is one executable task, even though its original
      // attempt budget is exhausted. It is still counted under retry.
      runnable += 1;
    } else if (status === "queued" && !job.retry_exhausted &&
        attempts < 2 && Number(job.media_waits || 0) < 2) {
      runnable += 1;
    } else if (!["queued", "running"].includes(status) &&
        (memoryStatus === "running" || memoryStatus === "queued" && memoryAttempts < 2)) {
      if (memoryStatus === "running") runningPostprocess = job;
      runnable += 1;
    }
  }
  for (const row of mediaRows) {
    const rowKeys = queueIdentityKeys(row);
    const businessStatus = mediaBusinessStatus(row);
    const matched = [...new Set([...rowKeys].flatMap(key => claimedMedia.get(key) || []))];
    if (matched.length) {
      // Calendar/memory completion cannot certify unread media. Merge the
      // real message phases by retry > new > success, counting it once.
      const priority = {success: 0, new: 1, retry: 2};
      const current = matched.reduce((best, value) =>
        (priority[value.state] ?? -1) > (priority[best.state] ?? -1) ? value : best);
      // A completed postprocess job is authoritative for historical rows
      // whose source audit later records an exhausted lookup.
      if (businessStatus === "retry" && current.state === "success") {
        continue;
      }
      if ((priority[businessStatus] ?? -1) > (priority[current.state] ?? -1)) {
        if (current.state) counts[current.state] -= 1;
        counts[businessStatus] += 1;
        current.state = businessStatus;
      }
      continue;
    }
    if (businessStatus === "new") {
      counts.new += 1;
      if (ACTIONABLE_MEDIA_STATUSES.has(String(row.status || ""))) runnable += 1;
    }
    // Exhausted manifest retries without a matching postprocess job are
    // historical audit records, not executable queue work.
    if (businessStatus === "retry" && !matched.length) continue;
  }
  return {
    newBacklog: counts.new,
    retryBacklog: counts.retry,
    successCount: counts.success,
    runningPostprocess,
    runnableBacklog: runnable,
  };
}

function mediaQueueStatus() {
  const counts = {};
  const errors = {};
  const failureClasses = {};
  const rows = [];
  let total = 0;
  try {
    for (const line of fs.readFileSync(MEDIA_MANIFEST_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        rows.push(row);
        total += 1;
        const status = String(row.status || "unknown");
        counts[status] = (counts[status] || 0) + 1;
        if (row.attachment_failure_class) {
          const fc = String(row.attachment_failure_class);
          failureClasses[fc] = (failureClasses[fc] || 0) + 1;
        }
        if (row.vision_last_error) {
          const key = String(row.vision_last_error);
          errors[key] = (errors[key] || 0) + 1;
        }
      } catch {
        /* ignore an incomplete trailing line */
      }
    }
  } catch {
    return { ok: false, error: "manifest unavailable" };
  }
  let workers = [];
  let cpuPercent = null;
  let gpuPercent = null;
  try {
    const ps = execFileSync("ps", ["-eo", "pid,pcpu,pmem,state,cmd", "--no-headers"], { encoding: "utf8" });
    const lines = ps.split("\n");
    workers = lines.filter((line) => line.includes("distill_media.py") && !line.includes("grep ")).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      return m ? { pid: Number(m[1]), cpu: Number(m[2]), memory: Number(m[3]), state: m[4], command: m[5] } : null;
    }).filter(Boolean);
  } catch {
    /* process metrics are best effort */
  }
  try { cpuPercent = sampleCpuUsage(); } catch { /* CPU metrics are best effort */ }
  try {
    // WSL exposes the Windows driver at this path even when nvidia-smi is not
    // on PATH. Keep the regular command for native Linux installs.
    const nvidiaSmi = fs.existsSync("/usr/lib/wsl/lib/nvidia-smi") ? "/usr/lib/wsl/lib/nvidia-smi" : "nvidia-smi";
    const rawGpu = execFileSync(nvidiaSmi, ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], { encoding: "utf8" });
    const values = rawGpu.split(/\s+/).map(Number).filter(Number.isFinite);
    if (values.length) gpuPercent = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
  } catch {
    /* GPU metrics are best effort when nvidia-smi is unavailable */
  }
  const canonical = canonicalQueueCounts(rows);
  const { newBacklog, retryBacklog } = canonical;
  const runnableBacklog = Number(canonical.runnableBacklog || 0);
  const businessCounts = {
    new: canonical.newBacklog,
    retry: canonical.retryBacklog,
    success: canonical.successCount,
  };
  const activeWorker = workers[0] || null;
  const currentTask = canonical.runningPostprocess
    ? { state: "running", label: "处理消息 · " + String(canonical.runningPostprocess.id || "").slice(0, 8) }
    : activeWorker
      ? { state: "running", label: "识别中 · worker " + activeWorker.pid + " · " + activeWorker.state }
      : (runnableBacklog > 0
        ? { state: "waiting", label: "等待处理 · " + runnableBacklog + " 条" }
        : (newBacklog + retryBacklog > 0
          ? { state: "blocked", label: "重试待修复 · " + retryBacklog + " 条" }
          : { state: "idle", label: "空闲" }));
  let bridge = false;
  try {
    const ps = execFileSync("pgrep", ["-f", "wechat-pc-bridge.js"], { encoding: "utf8" }).trim();
    bridge = Boolean(ps);
  } catch {
    bridge = false;
  }
  return {
    ok: true,
    at: new Date().toISOString(),
    total,
    counts,
    business_counts: businessCounts,
    current_task: currentTask,
    errors: Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    failure_classes: Object.entries(failureClasses).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    attachment_unresolved: Number(failureClasses.attachment_unresolved || 0),
    bridge,
    workers,
    backlog: newBacklog + retryBacklog,
    new_backlog: newBacklog,
    retry_backlog: retryBacklog,
    cpu_percent: cpuPercent,
    cpu_scope: "wsl",
    gpu_percent: gpuPercent,
  };
}

let previousCpuSample = null;
let currentCpuPercent = null;
function sampleCpuUsage() {
  // Interval utilization across all WSL logical CPUs, not the sum of ps's
  // per-core lifetime percentages (which can exceed 100%).
  const times = os.cpus().reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return sum;
  }, { idle: 0, total: 0 });
  const previous = previousCpuSample;
  if (previous && times.total > previous.total) {
    const total = times.total - previous.total;
    const idle = times.idle - previous.idle;
    if (idle >= 0 && idle <= total)
      currentCpuPercent = Number((100 * (total - idle) / total).toFixed(1));
  }
  previousCpuSample = times;
  return currentCpuPercent;
}

function loadPolicy() {
  return loadAccessPolicy();
}

function savePolicy(policy) {
  saveAccessPolicy(policy);
}

function loadBridgeNames() {
  return loadBridgeDisplayNames();
}

function allCategories(policy) {
  const c = policy.categories || {};
  const preset = c.preset?.length ? c.preset : DEFAULT_CATEGORIES.preset;
  const custom = c.custom || DEFAULT_CATEGORIES.custom || [];
  return [...preset, ...custom].filter(Boolean);
}

function maybeSyncDisplayNames(force = false) {
  let stale = force;
  if (!stale) {
    try {
      const stat = fs.statSync(DISPLAY_NAMES_PATH);
      stale = Date.now() - stat.mtimeMs > SYNC_MAX_AGE_MS;
    } catch {
      stale = true;
    }
  }
  if (!stale) return { synced: false };
  const r = spawnSync("node", [SYNC_SCRIPT], { encoding: "utf8", timeout: 90000 });
  if (r.status !== 0) {
    return { synced: false, error: (r.stderr || r.stdout || "sync failed").trim().slice(0, 200) };
  }
  try {
    return { synced: true, ...JSON.parse(r.stdout.trim()) };
  } catch {
    return { synced: true };
  }
}

function transcriptNickname(talker) {
  if (talker.endsWith("@chatroom")) return "";
  const file = path.join(TRANSCRIPT_DIR, `${talker}.jsonl`);
  if (!fs.existsSync(file)) return "";
  try {
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n").slice(0, 40)) {
      const row = JSON.parse(line);
      if (row.role === "assistant" || row.role === "我") continue;
      const nick = String(row.nickname || "").trim();
      if (nick && !/^wxid_|@[^@]+$/.test(nick) && nick !== talker && !/^(默认|未配置|群聊|联系人|我)$/.test(nick)) {
        return nick;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

function resolveDisplayName(talker, bridgeNames, lastMessage = "") {
  return displayNameForTalker(talker, transcriptNickname(talker), bridgeNames, { lastMessage });
}

function resolveCategory(talker, policy, bridgeNames, name) {
  return resolveCategoryForTalker(talker, name || "", bridgeNames);
}

function listGroups() {
  maybeSyncDisplayNames(false);
  const extraNames = buildExtraNames(loadBridgeNames());
  const policy = loadPolicy();
  const bridgeNames = extraNames;
  const seen = new Map();

  if (fs.existsSync(TRANSCRIPT_DIR)) {
    for (const f of fs.readdirSync(TRANSCRIPT_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const talker = f.replace(/\.jsonl$/, "");
      if (isHiddenFromGroupList(talker)) continue;
      const stat = fs.statSync(path.join(TRANSCRIPT_DIR, f));
      let lastMsg = "";
      let lastTs = 0;
      try {
        const lines = fs.readFileSync(path.join(TRANSCRIPT_DIR, f), "utf8").trim().split("\n");
        const last = lines[lines.length - 1];
        if (last) {
          const row = JSON.parse(last);
          lastMsg = String(row.content || "").slice(0, 80);
          lastTs = row.ts || 0;
        }
      } catch {
        /* ignore */
      }
      const name = resolveDisplayName(talker, bridgeNames, lastMsg);
      const category = resolveCategory(talker, policy, bridgeNames, name);
      seen.set(talker, {
        talker,
        name,
        category,
        reply_tier: getStoredReplyTier(talker),
        whitelisted: isWhitelistedForAutoReply(talker),
        auto_reply: shouldAutoReplyForTalker(talker, name, bridgeNames),
        last_message: lastMsg,
        last_ts: lastTs,
        mtime: stat.mtimeMs,
        is_group: talker.endsWith("@chatroom"),
      });
    }
  }

  const manualTalkers = new Set([
    ...Object.keys(loadBridgeDisplayNames()),
    ...Object.keys(policy.talker_categories || {}),
    ...Object.keys(policy.talkers || {}),
  ]);
  for (const talker of manualTalkers) {
    if (isHiddenFromGroupList(talker)) continue;
    if (!seen.has(talker)) {
      const disp = resolveDisplayName(talker, bridgeNames, "");
      const category = resolveCategory(talker, policy, bridgeNames, disp);
      seen.set(talker, {
        talker,
        name: disp,
        category,
        reply_tier: getStoredReplyTier(talker),
        whitelisted: isWhitelistedForAutoReply(talker),
        auto_reply: shouldAutoReplyForTalker(talker, disp, bridgeNames),
        last_message: "",
        last_ts: 0,
        mtime: 0,
        is_group: talker.endsWith("@chatroom"),
      });
    } else {
      const g = seen.get(talker);
      g.name = resolveDisplayName(talker, bridgeNames, g.last_message || "");
      g.category = resolveCategory(talker, policy, bridgeNames, g.name);
      g.reply_tier = getStoredReplyTier(talker);
      g.whitelisted = isWhitelistedForAutoReply(talker);
      g.auto_reply = shouldAutoReplyForTalker(talker, g.name, bridgeNames);
    }
  }

  return [...seen.values()].sort((a, b) => (b.last_ts || b.mtime) - (a.last_ts || a.mtime));
}

function readTranscript(talker, limit = 100) {
  const file = path.join(TRANSCRIPT_DIR, `${talker}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const rows = [];
  for (const line of lines.slice(-limit)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function runPythonJson(scriptPath, args, timeoutMs = 20000) {
  if (!fs.existsSync(scriptPath)) return { ok: false, error: "script-missing" };
  try {
    const out = execFileSync("python3", [scriptPath, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      cwd: WORKSPACE,
    }).trim();
    if (!out) return { ok: false, error: "empty-output" };
    return JSON.parse(out);
  } catch (e) {
    const msg = e.stderr?.toString?.() || e.message || "python failed";
    return { ok: false, error: String(msg).slice(0, 500) };
  }
}

// Feishu reconciliation can involve one request per locally linked event/task.
// Never run it through execFileSync from the HTTP handler: a slow or expired
// OAuth/network request would block every dashboard request, including static
// files.  Keep one shared background job and kill its process group on timeout
// so a timed-out Python child cannot remain attached to the service.
function runPythonJsonAsync(scriptPath, args, timeoutMs = 25000) {
  if (!fs.existsSync(scriptPath)) return Promise.resolve({ ok: false, error: "script-missing" });
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn("python3", [scriptPath, ...args], {
      cwd: WORKSPACE,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* child may have exited between the timeout and kill */
      }
      finish({ ok: false, error: `python timeout after ${timeoutMs}ms`, timeout: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 512 * 1024) stdout = stdout.slice(-512 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (error) => finish({ ok: false, error: String(error.message || error) }));
    child.on("close", (code, signal) => {
      if (settled) return;
      const out = stdout.trim();
      if (!out) {
        finish({ ok: false, error: (stderr.trim() || `python exited ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`).slice(0, 500) });
        return;
      }
      try {
        finish(JSON.parse(out));
      } catch {
        finish({ ok: false, error: `invalid python json: ${out.slice(0, 300)}` });
      }
    });
  });
}

function startCalendarPull() {
  if (!calendarPullJob) {
    calendarPullJob = runPythonJsonAsync(CALENDAR_DASHBOARD_SCRIPT, ["pull-feishu"], 180000)
      .then((result) => {
        calendarPullResult = { ...result, finished_at: new Date().toISOString() };
        return calendarPullResult;
      })
      .finally(() => {
        calendarPullJob = null;
      });
  }
  return calendarPullJob;
}

async function calendarSummary() {
  // A read/refresh must not write a competing state snapshot while the
  // background Feishu pull is running. The pull and training mutations already
  // rebuild the rolling todo; only read the current training status here.
  const [training, today] = await Promise.all([
    runPythonJsonAsync(TRAINING_LOG_SCRIPT, ["get"], 8000),
    runPythonJsonAsync(CALENDAR_DASHBOARD_SCRIPT, ["today-events"], 8000),
  ]);
  const state = readJson(CALENDAR_STATE, {});
  const feishuTasks = (state.feishu_sync && state.feishu_sync.tasks) || {};
  const events = today.ok ? today.events : [];

  const todos = [];
  const completed = [];
  for (const [id, t] of Object.entries(state.todo_items || state.todos || {})) {
    if (!t || typeof t !== "object") continue;
    const row = {
      id,
      feishu_linked: Boolean(feishuTasks[id]),
      ...t,
    };
    if (t.completed_at) completed.push(row);
    else todos.push(row);
  }
  const byTime = (a, b) => String(b.message_time || "").localeCompare(String(a.message_time || ""));
  todos.sort(byTime);
  completed.sort(byTime);
  return {
    events,
    events_date: today.date || "",
    events_error: today.ok ? null : today.error || "今日日程读取失败",
    todos: todos.slice(0, 40),
    completed: completed.slice(0, 20),
    training,
    feishu_enabled: Boolean(feishuTasks && Object.keys(feishuTasks).length),
  };
}

function isPrivatePersonTalker(talker) {
  const value = String(talker || "");
  if (!value || value.endsWith("@chatroom") || value.includes("@openim")) return false;
  if (/^(gh_|filehelper$|weixin$|notifymessage$|brandsessionholder$|brandservicesessionholder$|@placeholder)/i.test(value)) return false;
  return true;
}

function isHumanCorpusRow(row) {
  const content = String(row?.content || "").trim();
  if (!content || !["user", "assistant"].includes(row?.role)) return false;
  if (/agent/i.test(String(row?.source || ""))) return false;
  if (content.length > 100 && /^[0-9A-F]+$/i.test(content)) return false;
  if (/^<msg[>\s]/i.test(content)) return false;
  return true;
}

function listPeopleProfiles() {
  const store = readJson(PEOPLE_PROFILE_STORE, { people: {}, chats: {} });
  const people = Object.values(store.people || {}).filter((row) => row && typeof row === "object");
  const chats = store.chats || {};
  const bridgeNames = buildExtraNames(loadBridgeNames());
  const profiles = [];
  if (!fs.existsSync(TRANSCRIPT_DIR)) return profiles;

  for (const filename of fs.readdirSync(TRANSCRIPT_DIR)) {
    if (!filename.endsWith(".jsonl")) continue;
    const talker = filename.slice(0, -6);
    if (!isPrivatePersonTalker(talker)) continue;
    let rows = [];
    try {
      rows = fs.readFileSync(path.join(TRANSCRIPT_DIR, filename), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(isHumanCorpusRow);
    } catch {
      continue;
    }
    if (!rows.length) continue;
    const ownerCount = rows.filter((row) => row.role === "assistant").length;
    const otherCount = rows.filter((row) => row.role === "user").length;
    const last = rows.at(-1) || {};
    const chat = chats[talker] || {};
    const relationship = chat.relationship || {};
    const name = resolveDisplayName(talker, bridgeNames, String(last.content || ""));
    // Identity ownership must come from a stable wxid link. `talkers` only
    // records where a person was mentioned/spoke; the owner naturally appears
    // in every private chat and must never become that contact's profile.
    const directPerson = people.find((row) => (row.wxids || []).includes(talker));
    const exactNameMatches = people.filter((row) =>
      row.name === name || (row.aliases || []).includes(name));
    const person = directPerson || (exactNameMatches.length === 1 ? exactNameMatches[0] : null);
    const currentPositions = (person?.positions || []).filter((row) => row?.status === "current");
    const currentResponsibilities = (person?.responsibilities || []).filter((row) => row?.status === "current");
    profiles.push({
      talker,
      name,
      message_count: rows.length,
      owner_count: ownerCount,
      other_count: otherCount,
      corpus_chars: rows.reduce((sum, row) => sum + Math.min(1000, String(row.content || "").length), 0),
      last_time: last.time || "",
      last_ts: Number(last.ts || 0),
      closeness: relationship.closeness || "",
      closeness_confidence: Number(relationship.confidence || 0),
      interaction_style: (relationship.interaction_style || []).slice(0, 8),
      impression: String(chat.owner_impression || ""),
      impression_updated_at: chat.owner_impression_updated_at || "",
      aliases: (person?.aliases || []).slice(0, 12),
      facts: (person?.facts || []).slice(-8),
      relationships: (person?.relationships || []).slice(-6),
      positions: currentPositions.slice(-4),
      responsibilities: currentResponsibilities.slice(-5),
      search_text: rows
        .slice(-120)
        .map((row) => String(row.content || "").slice(0, 240))
        .join("\n")
        .slice(-12000),
    });
  }
  profiles.sort((a, b) =>
    b.message_count - a.message_count ||
    b.corpus_chars - a.corpus_chars ||
    b.last_ts - a.last_ts ||
    a.name.localeCompare(b.name, "zh-CN"));
  return profiles.map((row, index) => ({ ...row, rank: index + 1 }));
}

function personProfileDetail(talker) {
  const profile = listPeopleProfiles().find((row) => row.talker === talker);
  if (!profile) return null;
  const file = path.join(TRANSCRIPT_DIR, `${talker}.jsonl`);
  let messages = [];
  try {
    messages = fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(isHumanCorpusRow)
      .slice(-50)
      .map((row) => ({
        role: row.role === "assistant" ? "我" : profile.name,
        side: row.role === "assistant" ? "owner" : "other",
        time: row.time || "",
        content: String(row.content || "").slice(0, 1200),
        kind: row.media_kind || (row.msg_kind === "3" ? "image" : "text"),
      }));
  } catch {
    messages = [];
  }

  const summary = [];
  if (profile.closeness) {
    summary.push(`关系判断：${profile.closeness}（置信度 ${profile.closeness_confidence.toFixed(2)}）`);
  } else {
    summary.push("关系判断：仍在积累双向语料，暂不武断定级");
  }
  if (profile.interaction_style.length) summary.push(`互动方式：${profile.interaction_style.join("、")}`);
  if (profile.positions.length) {
    summary.push(`当前身份：${profile.positions.map((row) => [row.organization, row.title].filter(Boolean).join(" ")).filter(Boolean).join("；")}`);
  }
  if (profile.responsibilities.length) {
    summary.push(`明确职责：${profile.responsibilities.map((row) => row.domain).filter(Boolean).join("、")}`);
  }
  if (profile.facts.length) summary.push(`近期可确认信息：${profile.facts.slice(-5).join("；")}`);
  if (!profile.facts.length && !profile.positions.length && !profile.responsibilities.length) {
    summary.push("稳定事实仍较少，Agent 会继续从有明确证据的双方消息中补充档案");
  }
  return { ...profile, agent_summary: summary, recent_messages: messages };
}

function extractSearchKeywords(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const kws = new Set();
  for (const w of ["足协杯", "足协", "足联", "赛程", "比赛", "洪蓝", "明觉", "飞鹰", "网络培训", "师德师风"]) {
    if (t.includes(w)) kws.add(w);
  }
  if (/午练|午辅|午辅导/.test(t)) {
    kws.add("午辅");
    kws.add("午辅导");
    kws.add("开学第一周");
    kws.add("过渡表");
  }
  if (/足协|足协杯|比赛|赛程|下场|什么时候|几点|场地|对手|报名|培训|待办|研修/.test(t)) {
    if (/培训|研修|师德/.test(t)) kws.add("网络培训");
    if (/足协|足协杯|比赛|赛程/.test(t)) kws.add("足协杯");
  }
  const tokens = t.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const tok of tokens) {
    if (/^(最近|什么|时候|吗|哪|多少|请问|有没有|怎么|如何|一下|告诉|总结|内容|相关|关于|帮我|查一下|待办|任务)$/.test(tok)) {
      continue;
    }
    kws.add(tok);
  }
  if (!kws.size) kws.add(t.slice(0, 24));
  return [...kws].slice(0, 6);
}

function runPythonScript(scriptPath, args, timeoutMs = 12000) {
  if (!fs.existsSync(scriptPath)) return "";
  try {
    return execFileSync("python3", [scriptPath, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
    }).trim();
  } catch {
    return "";
  }
}

function geminiFallbackEnv() {
  const env = { ...process.env };
  const envPath = path.join(__dirname, "../scripts/gemini-api.env");
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function geminiFallbackAnswer(prompt) {
  if (!fs.existsSync(GEMINI_FALLBACK_SCRIPT) || !String(prompt || "").trim()) return null;
  try {
    const out = execFileSync("python3", [GEMINI_FALLBACK_SCRIPT], {
      encoding: "utf8",
      input: JSON.stringify({ prompt: String(prompt) }),
      timeout: 90000,
      maxBuffer: 512 * 1024,
      cwd: WORKSPACE,
      env: geminiFallbackEnv(),
    }).trim();
    const result = JSON.parse(out || "{}");
    return result.ok && result.answer ? result : null;
  } catch {
    return null;
  }
}

function needsGeminiAnswerFallback(text, injectedPrompt) {
  const answer = String(text || "").trim();
  if (!answer || /^(?:NO_REPLY|__NO_REPLY__|No response from OpenClaw\.?)$/i.test(answer)) return true;
  const hasRetrievedEvidence = /【(?:微信语料检索|检索参考|待办查询|人物与关系档案)/.test(
    String(injectedPrompt || ""),
  );
  return hasRetrievedEvidence && /无法确认|无法查询|没有明确.{0,12}(?:记录|信息)|请提供更多信息/.test(answer);
}

function todoSnippet(text, allowedTiers = ["work"]) {
  if (!text || text.length < 2) return "";
  const out = runPythonScript(
    TODO_QUERY_SCRIPT,
    [text, "--tiers", (allowedTiers || ["work"]).join(",")],
  );
  if (!out || out.startsWith("[-]")) return "";
  return out.length > 8000 ? `${out.slice(0, 8000)}…` : out;
}

function knowledgeSnippet(text, allowedTiers = ["work"]) {
  if (!text || text.length < 4) return "";
  const lunchSchedule = /午练|午辅|午辅导/.test(String(text));
  // “午练”是用户口语，通知和文件实际使用“午辅/午辅导”。不要再用
  // “午练”命中用户自己的历史追问；那会把旧 Agent 错答重新注入本轮。
  // 此类请求以最新工作群原始消息和真实文件为事实源，关闭向量兜底，
  // 避免语义相近但主题错误的旧成绩表混入。
  const keywords = lunchSchedule
    ? ["午辅", "午辅导", "开学第一周", "过渡表", "课后服务"]
    : extractSearchKeywords(text);
  if (!keywords.length) return "";
  const args = ["--multi", keywords.join(","), "--tiers", (allowedTiers || ["work"]).join(",")];
  if (lunchSchedule) args.push("--prefer-groups", "--no-vector");
  const out = runPythonScript(
    KNOWLEDGE_SEARCH_SCRIPT,
    args,
  );
  if (!out || out.startsWith("[-]")) return "";
  return out.length > 2500 ? `${out.slice(0, 2500)}…` : out;
}

function normalizeFileSearchTerms(question) {
  const q = String(question || "").trim();
  const terms = new Set(
    q.split(/[\s，。！？、；：,.!?;:（）()【】\[\]“”"'·/\\]+/).filter((term) => term.length >= 2),
  );
  if (/午练|午辅|午辅导/.test(q)) {
    terms.add("午练");
    terms.add("午辅");
    terms.add("午辅导");
    terms.add("课后服务");
    terms.add("开学第一周");
    terms.add("过渡表");
  }
  if (/晚练|晚辅|晚辅导/.test(q)) {
    terms.add("晚练");
    terms.add("晚辅");
    terms.add("晚辅导");
  }
  return [...terms];
}

function fileCandidateScore(question, candidate, now = Date.now()) {
  const q = String(question || "");
  const name = String(candidate.name || "");
  const label = String(candidate.group_label || candidate.nickname || candidate.talker || "");
  const terms = normalizeFileSearchTerms(q);
  let score = terms.reduce((total, term) => total + (name.includes(term) ? 18 : 0), 0);
  const lunchSchedule = /午练|午辅|午辅导/.test(q);
  if (lunchSchedule && /午练|午辅|午辅导/.test(name)) score += 120;
  if (lunchSchedule && /开学第一周|过渡表|课后服务/.test(name)) score += 60;
  if (lunchSchedule && /成绩|分数|排名|训练成绩/.test(name)) score -= 240;
  if (/工作群|教师群|年级群|初三|2026-2027/.test(label)) score += 35;
  const timestamp = Number(candidate.mtimeMs || candidate.ts || 0);
  const ageMs = timestamp > 0 ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY;
  if (ageMs <= 6 * 60 * 60 * 1000) score += 90;
  else if (ageMs <= 24 * 60 * 60 * 1000) score += 70;
  else if (ageMs <= 3 * 24 * 60 * 60 * 1000) score += 45;
  else if (ageMs <= RECENT_FILE_WINDOW_MS) score += 15;
  return score;
}

function scanRecentWechatFiles() {
  if (Date.now() - recentWechatFileCache.at < RECENT_FILE_CACHE_MS) {
    return recentWechatFileCache.rows;
  }
  const results = [];
  const cutoff = Date.now() - RECENT_FILE_WINDOW_MS;
  const allowed = /\.(?:xlsx?|csv|docx?|pdf)$/i;
  for (const root of XWECHAT_FILE_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let scanRoots = [root];
    if (path.basename(root) === "xwechat_files") {
      try {
        scanRoots = fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(root, entry.name, "msg", "file"))
          .filter((candidate) => fs.existsSync(candidate));
      } catch {
        scanRoots = [root];
      }
    }
    const pending = [...scanRoots];
    let visited = 0;
    while (pending.length && visited < 12000) {
      const dir = pending.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(file);
          continue;
        }
        if (!entry.isFile() || !allowed.test(entry.name)) continue;
        try {
          const stat = fs.statSync(file);
          if (stat.mtimeMs < cutoff) continue;
          results.push({
            id: `cache:${file}`,
            kind: "file",
            file,
            name: entry.name,
            file_name: entry.name,
            mtimeMs: stat.mtimeMs,
            ts: stat.mtimeMs,
            time: new Date(stat.mtimeMs).toISOString(),
            source: "wechat_cache",
          });
        } catch {
          /* file disappeared during scan */
        }
      }
    }
  }
  recentWechatFileCache = { at: Date.now(), rows: results };
  return results;
}

function capturedFileSnippet(question) {
  const q = String(question || "").trim();
  if (!/文件|附件|表格|工作簿|xlsx|xls|csv|名单|成绩|家访|电访|刚刚|最新|上面那份|这份|午练|午辅|午辅导|晚辅/.test(q)) return "";
  const latest = new Map();
  const manifestByName = new Map();
  if (fs.existsSync(MEDIA_MANIFEST_PATH)) {
    for (const line of fs.readFileSync(MEDIA_MANIFEST_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const key = row.id || row.message_key;
        if (key) latest.set(key, row);
        const knownName = String(row.file_name || "").trim();
        if (knownName) manifestByName.set(knownName, row);
      } catch {
        /* skip damaged historical row */
      }
    }
  }
  for (const row of scanRecentWechatFiles()) {
    const manifest = manifestByName.get(row.name) || {};
    latest.set(row.id, { ...manifest, ...row, group_label: manifest.group_label || row.group_label });
  }
  const lunchSchedule = /午练|午辅|午辅导/.test(q);
  const rows = [...latest.values()]
    .filter((row) => row.kind === "file")
    .map((row) => {
      const file = row.file || row.canonical_file || row.path_hint || "";
      const name = row.file_name || (file ? path.basename(file) : "");
      const stat = file && fs.existsSync(file) ? fs.statSync(file) : null;
      const candidate = { ...row, file, name, mtimeMs: row.mtimeMs || stat?.mtimeMs || 0 };
      return { ...candidate, score: fileCandidateScore(q, candidate) };
    })
    .filter((row) => row.file && fs.existsSync(row.file))
    .filter((row) => !lunchSchedule || row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.mtimeMs || b.ts || 0) - Number(a.mtimeMs || a.ts || 0))
    .slice(0, 6);
  if (!rows.length) return "";
  return [
    "【微信文件本体 · 必须读取真实文件后回答】",
    "以下路径仅供 Agent 调用本地工具，不要向用户展示内部路径。若问题涉及表格内容，必须实际读取/计算，不能只依据文件名或旧摘要。",
    ...rows.map((row, index) =>
      `${index + 1}. 文件名：${row.name || "未命名文件"}；时间：${row.time || ""}；聊天：${row.group_label || row.nickname || row.talker || ""}；SHA256：${row.file_sha || ""}；本体：${row.file}`,
    ),
  ].join("\n");
}

function peopleProfileSnippet(text) {
  if (!text || text.length < 2) return "";
  const out = runPythonScript(
    PEOPLE_MEMORY_SCRIPT,
    ["--query", String(text), "--talker", "", "--json"],
    8000,
  );
  if (!out) return "";
  try {
    const result = JSON.parse(out);
    return result.ok && result.corpus ? String(result.corpus).slice(0, 6000) : "";
  } catch {
    return "";
  }
}

function uploadedSpreadsheetResult(text, allowedTiers = ["work"]) {
  if (!/成绩|分数|多少分|几分|排名|第几|名次|平均|均分|最高分|最低分/.test(String(text || ""))) {
    return null;
  }
  const out = runPythonScript(
    UPLOAD_QUERY_SCRIPT,
    ["--question", String(text), "--tiers", (allowedTiers || ["work"]).join(",")],
    45000,
  );
  if (!out) return null;
  try {
    const result = JSON.parse(out);
    return result.ok && result.answer ? result : null;
  } catch {
    return null;
  }
}

function uploadedSpreadsheetQuestion(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  const users = normalized.filter((m) => m.role === "user");
  const current = String(users.at(-1)?.content || "").trim();
  const isDataQuery = (value) =>
    /成绩|分数|多少分|几分|排名|第几|名次|平均|均分|最高分|最低分/.test(String(value || ""));
  if (isDataQuery(current)) return current;
  if (!/(?:初一|初二|初三|七年级|八年级|九年级|期末|期中|月考|考试|测验)/.test(current)) {
    return current;
  }
  const prior = users.slice(0, -1).reverse().find((m) => isDataQuery(m.content));
  return prior ? `${prior.content}\n用户补充：${current}` : current;
}

function uploadedSpreadsheetSnippet(text, allowedTiers = ["work"]) {
  const result = uploadedSpreadsheetResult(text, allowedTiers);
  if (!result) return "";
  return [
    "【已上传语料精确查询 · 必须采用计算结果】",
    `文档：${result.title}`,
    `原表：${result.file}`,
    `计算结果：${result.answer}`,
  ].join("\n");
}

function isCalendarMutationQuestion(text) {
  const value = String(text || "");
  return /(?:日历|课程表|课程|课表|飞书)/.test(value) &&
    /(?:补充|修改|更新|修复|恢复|改成|改为|替换|删除|取消|添加|新增|写入|写|同步|推送|做进|放进|记入)/.test(value);
}

function calendarMutationIntent(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const text = rows.map((row) => String(row?.content || "")).join("\n");
  return isCalendarMutationQuestion(text) ||
    /(?:日历|课程表|课表|飞书).*(?:推送|写入|同步|恢复|替换|删除|取消|修改|更新)/s.test(text);
}

function calendarMutationSnippet() {
  const state = readJson(CALENDAR_STATE, {});
  const events = Object.entries(state.calendar_events || {})
    .map(([uid, event]) => ({
      uid,
      title: String(event?.title || event?.summary || ""),
      start: String(event?.start_time || ""),
      end: String(event?.end_time || ""),
      recurrence: String(event?.recurrence || ""),
      eventId: String(state.feishu_sync?.calendar?.[uid] || ""),
    }))
    .filter((row) => row.title || row.start)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 40);
  return [
    "【日历写入专用现场】",
    `状态文件：calendar/distiller_state.json；当前事件数：${Object.keys(state.calendar_events || {}).length}。`,
    "新增一个或多个事件：必须把自然语言拆成结构化 events 数组，并调用 python3 skills/wechat-calendar/calendar_tool.py create-events --stdin。修改使用 calendar_tool.py update-event <uid> --stdin；删除使用 calendar_tool.py delete-event <uid>；查询使用 calendar_tool.py list-events。",
    "节次时间只能交给 calendar_tool.py 的 period 字段换算，不得自行猜钟点。禁止直接编辑 calendar/tasks.ics；禁止直接编辑 calendar/distiller_state.json；禁止运行 realtime_calendar.py --resync；禁止创建临时改写脚本。",
    "只有工具逐项返回 ok=true、真实 uid 和飞书 event_id 后才能声称成功。部分失败必须逐项原样说明 reason/detail，不能只说 Bad Gateway，也不能把多项安排合并成一个日程。",
    "若目标事件在状态库缺失，必须先从飞书原 event_id 或可靠备份恢复同一 UID，禁止创建重复课程。",
    "证据优先级：同一聊天、同一主题下，发布时间更晚的结构化原文件（xlsx/csv/docx/pdf）高于较早图片、OCR、缩略图和 Agent 历史总结；图片/OCR只可补充原文件缺失字段，不得凭推断覆盖更新文件。活跃工作群的最新原始消息高于私人测试对话里的复述。",
    "替换日程必须原子化：先 create-events/update-event 并确认每项 ok=true、取得真实 uid/event_id，再删除已明确被替代的旧项。新项写入失败时严禁删除旧项；没有明确撤回、改期或更新版证据时也不得主动删除。",
    ...events.map((row) =>
      `uid=${row.uid} | event_id=${row.eventId || "MISSING"} | ${row.title} | ${row.start}~${row.end} | ${row.recurrence || "无重复规则"}`,
    ),
  ].join("\n");
}

function buildChatCorpus(question) {
  if (isCalendarMutationQuestion(question)) {
    const capturedFiles = capturedFileSnippet(question);
    const knowledge = knowledgeSnippet(question, ["work"]);
    return [calendarMutationSnippet(), capturedFiles, knowledge].filter(Boolean).join("\n\n");
  }
  const uploaded = uploadedSpreadsheetSnippet(question, ["work"]);
  // An exact spreadsheet computation is authoritative. Do not dilute it with
  // keyword hits from older chats/files that merely share words such as
  // “期末” or “1班”; those contradictory candidates previously overruled the
  // agent's correct tool result.
  if (uploaded) {
    return [
      "【精确工具结果 · 这是本轮唯一的数据事实源】",
      uploaded,
    ].join("\n\n");
  }
  const todo = todoSnippet(question, ["work", "private"]);
  const peopleProfile = peopleProfileSnippet(question);
  const knowledge = knowledgeSnippet(question, ["work"]);
  const capturedFiles = capturedFileSnippet(question);
  const parts = [capturedFiles, peopleProfile, todo, knowledge].filter(Boolean);
  if (!parts.length) return "";
  return [
    "【检索参考 · 回答待办/培训/通知类问题时必须优先使用以下本地记录，禁止让用户自己去查】",
    ...parts,
  ].join("\n\n");
}

function injectChatCorpus(messages, resolvedQuestion = "") {
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].role !== "user") continue;
    const question = String(out[i].content || "").trim();
    if (!question) return out;
    const corpus = buildChatCorpus(resolvedQuestion || question);
    out[i] = {
      ...out[i],
      content: [
        corpus,
        `【用户问题】\n${question}`,
        "【Dashboard 对话要求】这是用户主动发给 Agent 的消息，本轮必须正常回复；证据不足时明确说明不确定，禁止输出 NO_REPLY。只输出面向用户的中文最终答案，不得输出英文分析、推理草稿、内部路径、工具调用过程或重复的两版答案。若用户要求修改、补充、删除、同步日历或待办，必须实际调用现有本地工具完成写入并核验；成功回复必须包含真实本地 uid 和飞书 event_id（如该项应同步飞书），任何一步失败都必须明确报失败，禁止只口头说“已处理/已确认”。工具返回正常文本时必须直接基于返回内容继续任务，禁止声称工具结果“变成图片/无法解析”，也禁止沿用历史会话中出现过的“链路故障/图片”叙述——只有本轮工具调用确实返回错误时才允许报告错误。",
      ].filter(Boolean).join("\n\n"),
    };
    return out;
  }
  return out;
}

function trimChatHistory(messages, limit = CHAT_HISTORY_LIMIT) {
  const normalized = Array.isArray(messages) ? messages : [];
  if (normalized.length <= limit) return normalized.map((m) => ({ ...m }));
  return normalized.slice(-limit).map((m) => ({ ...m }));
}

function gatewayErrorDetails(statusCode, parsed, rawText = "") {
  const message = String(
    parsed?.error?.message || parsed?.error || parsed?.message || rawText || "",
  ).trim();
  if (/context overflow|context size exceeds|maximum context|context length/i.test(message)) {
    return {
      status: 413,
      error: "Agent 上下文超限，Dashboard 已停止等待。请重试；服务端不会再转发整段历史。",
      code: "agent_context_overflow",
    };
  }
  if (Number(statusCode) >= 400) {
    return {
      status: 502,
      error: message || `OpenClaw gateway HTTP ${statusCode}`,
      code: "gateway_error",
    };
  }
  return null;
}

function mutationReplyError(question, reply, contextualMutation = false) {
  if (!contextualMutation && !isCalendarMutationQuestion(question)) return null;
  const text = String(reply || "");
  const hasUid = /[0-9a-f]{24}@openclaw\.local/i.test(text);
  const needsFeishu = /飞书|同步/.test(String(question || ""));
  const hasEventId = /[0-9a-f]{8}-[0-9a-f-]{27,}(?:_\d+)?/i.test(text);
  if (!hasUid || (needsFeishu && !hasEventId)) {
    return {
      status: 502,
      error: "Agent 未返回可验收的真实 uid/event_id，本次操作按失败处理，不能视为已写入。",
      code: "agent_write_unverified",
    };
  }
  // A plausible identifier is insufficient: verify it against tool state.
  const state = readJson(CALENDAR_STATE, {});
  const uids = [...text.matchAll(/[0-9a-f]{24}@openclaw\.local/gi)].map(m => m[0]);
  const eventIds = [...text.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27,}(?:_\d+)?/gi)].map(m => m[0]);
  const calendar = state.calendar_events || {};
  const sync = state.feishu_sync?.calendar || {};
  if (uids.some(uid => !calendar[uid]) ||
      (needsFeishu && (uids.some(uid => !eventIds.includes(String(sync[uid] || ""))) ||
        eventIds.some(id => !uids.some(uid => String(sync[uid] || "") === id))))) {
    return {status: 502, code: "agent_write_receipt_mismatch",
      error: "Agent 返回的 uid/event_id 与本地真实日历回执不匹配，需要核对，未重新执行。"};
  }
  return null;
}

function signSession() {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (sig !== expect) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  });
  res.end(body);
}

function requireAuth(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.wechat_dash;
  if (!verifySession(token)) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function gatewayRequest(bodyObj, stream = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const url = new URL("/v1/chat/completions", GATEWAY);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        timeout: GATEWAY_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => resolve(res),
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("gateway timeout")));
    req.write(body);
    req.end();
  });
}

function readGatewayJson(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve({ raw, parsed: JSON.parse(raw) }); } catch (err) { reject(err); }
    });
  });
}

function saveChatJobs() {
  fs.mkdirSync(path.dirname(CHAT_JOB_FILE), { recursive: true });
  const temp = `${CHAT_JOB_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, jobs: [...chatJobs.values()] }, null, 2), "utf8");
  fs.renameSync(temp, CHAT_JOB_FILE);
}

function reconcileLoadedChatJob(job) {
  if (job.status === "running") {
    job.status = "failed";
    job.code = "task_outcome_unknown";
    job.error = "服务重启前任务已开始，需先回读核对执行结果，未重复执行。";
    delete job.result;
    return true;
  }
  if (job.status === "succeeded") {
    const mutation = job.calendarMutationRequested || calendarMutationIntent(job.payload?.messages);
    const error = mutationReplyError(job.latestQuestion, job.result?.reply, mutation);
    if (error) {
      job.status = "failed";
      job.code = error.code;
      job.error = error.error;
      delete job.result;
      return true;
    }
  }
  return false;
}

function loadChatJobs() {
  try {
    const saved = JSON.parse(fs.readFileSync(CHAT_JOB_FILE, "utf8"));
    for (const job of Array.isArray(saved?.jobs) ? saved.jobs : []) {
      if (!job?.id || !job?.payload) continue;
      reconcileLoadedChatJob(job);
      chatJobs.set(job.id, job);
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[wechat-dashboard] chat job load:", err.message);
  }
}

async function executeChatPayload(payload, latestQuestion, exactSpreadsheet) {
  const gw = await gatewayRequest(payload, false);
  const { raw, parsed } = await readGatewayJson(gw);
  const gatewayError = gatewayErrorDetails(gw.statusCode, parsed, raw);
  if (gatewayError) {
    const err = new Error(gatewayError.error);
    err.code = gatewayError.code;
    throw err;
  }
  let text = parsed?.choices?.[0]?.message?.content || "";
  let source;
  const injectedPrompt = payload.messages.filter((m) => m.role === "user").at(-1)?.content || "";
  if (exactSpreadsheet && needsGeminiAnswerFallback(text, injectedPrompt)) {
    text = exactSpreadsheet.answer;
    source = { type: "uploaded-spreadsheet-fallback", title: exactSpreadsheet.title, file: exactSpreadsheet.file };
  } else if (needsGeminiAnswerFallback(text, injectedPrompt)) {
    const fallback = geminiFallbackAnswer(injectedPrompt);
    if (fallback?.answer) {
      text = fallback.answer;
      source = { type: "gemini-answer-fallback", model: fallback.model };
    }
  }
  const writeError = mutationReplyError(latestQuestion, text, calendarMutationIntent(payload.messages));
  if (writeError) {
    const err = new Error(writeError.error);
    err.code = writeError.code;
    throw err;
  }
  return { reply: text, raw: parsed, source };
}

function enqueueChatJob(payload, latestQuestion, exactSpreadsheet) {
  // Re-submitting after a browser/network failure must attach to the same
  // calendar operation, never start a second write.
  const id = crypto.createHash("sha256")
    .update(JSON.stringify({ latestQuestion, messages: payload.messages }))
    .digest("hex")
    .slice(0, 24);
  const existing = chatJobs.get(id);
  if (existing) return existing;
  const now = new Date().toISOString();
  chatJobs.set(id, { id, status: "queued", created_at: now, updated_at: now, payload, latestQuestion, exactSpreadsheet });
  saveChatJobs();
  runChatJobWorker().catch((err) => console.error("[wechat-dashboard] chat worker:", err.message));
  return chatJobs.get(id);
}

async function runChatJobWorker() {
  if (chatJobWorkerRunning) return;
  chatJobWorkerRunning = true;
  try {
    for (;;) {
      const job = [...chatJobs.values()].find((entry) => entry.status === "queued");
      if (!job) break;
      job.status = "running";
      job.updated_at = new Date().toISOString();
      saveChatJobs();
      try {
        job.result = await executeChatPayload(job.payload, job.latestQuestion, job.exactSpreadsheet);
        job.status = "succeeded";
      } catch (err) {
        job.status = "failed";
        job.error = String(err.message || err);
        job.code = err.code || "agent_execution_failed";
      }
      job.updated_at = new Date().toISOString();
      job.completed_at = job.updated_at;
      saveChatJobs();
    }
  } finally { chatJobWorkerRunning = false; }
}

function wechatHookRequest(apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const bridgeCfg = loadBridgeConfig();
    const base = process.env.WECHAT_HOOK_BASE_URL || bridgeCfg.hook_base_url || "http://127.0.0.1:30001";
    const url = new URL(apiPath, base);
    const body = JSON.stringify(bodyObj || {});
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (chunk) => chunks.push(chunk));
        resp.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            if (resp.statusCode >= 400 || Number(parsed.ret ?? 0) !== 0) {
              reject(new Error(parsed.retmsg || parsed.msg || `hook ${resp.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("wechat hook timeout")));
    req.write(body);
    req.end();
  });
}

function splitWechatText(text, maxChars = 1600) {
  const chars = Array.from(String(text || "").trim());
  const chunks = [];
  while (chars.length) chunks.push(chars.splice(0, maxChars).join(""));
  return chunks;
}

async function deliverAgentText(target, text) {
  const cfg = loadBridgeConfig();
  const wxid = target === "filehelper" ? "filehelper" : target === "test" ? cfg.test_wxid : "";
  if (!wxid) throw new Error("delivery target is not configured");
  const chunks = splitWechatText(text);
  if (!chunks.length) throw new Error("empty reply");
  for (let i = 0; i < chunks.length; i += 1) {
    const prefix = chunks.length > 1 ? `【agent】（${i + 1}/${chunks.length}）：` : "【agent】：";
    await wechatHookRequest("/SendTextMsg", { wxidorgid: wxid, msg: `${prefix}${chunks[i]}` });
    if (i + 1 < chunks.length) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { ok: true, target, chunks: chunks.length };
}

function serveStatic(req, res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  const data = fs.readFileSync(filePath);
  // Live queue assets must not be served from a stale browser cache.
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
  });
  res.end(data);
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/login" && req.method === "POST") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (body.password !== DASHBOARD_PASSWORD) {
      return json(res, 403, { error: "wrong password" });
    }
    const token = signSession();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `wechat_dash=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "wechat_dash=; HttpOnly; Path=/; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const cookies = parseCookies(req.headers.cookie);
    return json(res, verifySession(cookies.wechat_dash) ? 200 : 401, {
      ok: verifySession(cookies.wechat_dash),
      agent: AGENT_MODEL,
    });
  }

  if (!requireAuth(req, res)) return;

  if (pathname === "/api/media-status" && req.method === "GET") {
    return json(res, 200, mediaQueueStatus());
  }

  if (pathname === "/api/groups" && req.method === "GET") {
    const u = new URL(req.url, "http://local");
    const syncInfo = u.searchParams.get("sync") === "1" ? maybeSyncDisplayNames(true) : null;
    return json(res, 200, { groups: listGroups(), sync: syncInfo });
  }

  if (pathname === "/api/people-profiles" && req.method === "GET") {
    return json(res, 200, { ok: true, profiles: listPeopleProfiles() });
  }

  if (pathname.startsWith("/api/people-profiles/") && !pathname.endsWith("/impression") && req.method === "GET") {
    const talker = decodeURIComponent(pathname.slice("/api/people-profiles/".length));
    const profile = personProfileDetail(talker);
    if (!profile) return json(res, 404, { error: "profile not found" });
    return json(res, 200, { ok: true, profile });
  }

  if (pathname.startsWith("/api/people-profiles/") && pathname.endsWith("/impression") && req.method === "PUT") {
    const talker = decodeURIComponent(
      pathname.slice("/api/people-profiles/".length, -"/impression".length),
    );
    if (!isPrivatePersonTalker(talker)) return json(res, 400, { error: "invalid private contact" });
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const impression = String(body.impression || "").trim().slice(0, 2000);
    const result = runPythonJson(
      PEOPLE_MEMORY_SCRIPT,
      ["--set-impression", "--talker", talker, "--impression", impression, "--json"],
      8000,
    );
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, result);
  }

  if (pathname === "/api/sync-names" && req.method === "POST") {
    return json(res, 200, maybeSyncDisplayNames(true));
  }

  if (pathname.startsWith("/api/groups/") && req.method === "PUT") {
    const talker = decodeURIComponent(pathname.slice("/api/groups/".length));
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const policy = loadPolicy();
    policy.talker_categories = policy.talker_categories || {};
    policy.talkers = policy.talkers || {};
    const extra = buildExtraNames(loadBridgeNames());
    const wechatName = resolveDisplayName(talker, extra, "");
    const category = body.category;
    if (category) {
      policy.talker_categories[talker] = category;
      const pool = CATEGORY_POOL[category] || "private";
      const label =
        body.name ||
        policy.talkers[talker]?.label ||
        (wechatName && wechatName !== "群聊" && wechatName !== "联系人" ? wechatName : undefined);
      policy.talkers[talker] = {
        ...(policy.talkers[talker] || {}),
        category,
        content_pool: pool,
        ...(label ? { label } : {}),
      };
    }
    if (body.name) {
      policy.talkers[talker] = { ...(policy.talkers[talker] || {}), label: body.name };
      policy.display_name_overrides = policy.display_name_overrides || {};
      policy.display_name_overrides[talker] = body.name;
      try {
        const bridge = loadBridgeConfig();
        bridge.group_display_names = bridge.group_display_names || {};
        bridge.group_display_names[talker] = body.name;
        saveBridgeConfig(bridge);
      } catch (e) {
        return json(res, 500, { error: `写入失败: ${e.message}` });
      }
    }
    if ("reply_tier" in body && REPLY_TIERS.includes(body.reply_tier)) {
      policy.talkers[talker] = { ...(policy.talkers[talker] || {}), reply_tier: body.reply_tier };
    } else if (body.auto_reply === false) {
      policy.talkers[talker] = { ...(policy.talkers[talker] || {}), reply_tier: "off" };
    } else if (body.auto_reply === true) {
      const prev = policy.talkers[talker]?.reply_tier;
      const tier = prev && prev !== "off" ? prev : "friend";
      policy.talkers[talker] = { ...(policy.talkers[talker] || {}), reply_tier: tier };
    }
    if (category || body.name || body.reply_tier != null || body.auto_reply != null) {
      savePolicy(policy);
    }
    return json(res, 200, {
      ok: true,
      group: listGroups().find((g) => g.talker === talker),
    });
  }

  if (pathname === "/api/auto-reply" && req.method === "GET") {
    const settings = getAutoReplySettings();
    const bridge = loadBridgeConfig();
    const whitelist = listWhitelistedTalkers().map((w) => ({
      ...w,
      name: displayNameForTalker(w.talker, w.label),
    }));
    return json(res, 200, {
      ...settings,
      whitelist,
      whitelist_count: whitelist.length,
      mode: bridge.auto_reply_mode || "policy",
      tier_labels: REPLY_TIER_LABELS,
      active_tiers: REPLY_TIERS.filter((t) => t !== "off"),
    });
  }

  if (pathname === "/api/auto-reply" && req.method === "PUT") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const policy = loadPolicy();
    policy.auto_reply = policy.auto_reply || {};
    if (body.enabled != null) policy.auto_reply.enabled = Boolean(body.enabled);
    savePolicy(policy);
    if (body.mode === "policy" || body.mode === "whitelist") {
      const bridge = loadBridgeConfig();
      bridge.auto_reply_mode = body.mode;
      saveBridgeConfig(bridge);
    }
    return json(res, 200, { ok: true, settings: getAutoReplySettings() });
  }

  if (pathname === "/api/categories" && req.method === "GET") {
    const policy = loadPolicy();
    return json(res, 200, {
      preset: policy.categories?.preset || [],
      custom: policy.categories?.custom || [],
      all: allCategories(policy),
    });
  }

  if (pathname === "/api/categories" && req.method === "POST") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { error: "name required" });
    const policy = loadPolicy();
    policy.categories = policy.categories || { preset: [], custom: [] };
    const all = allCategories(policy);
    if (!all.includes(name)) {
      policy.categories.custom = [...(policy.categories.custom || []), name];
      savePolicy(policy);
    }
    return json(res, 200, { ok: true, all: allCategories(policy) });
  }

  if (pathname.startsWith("/api/transcript/") && req.method === "GET") {
    const talker = decodeURIComponent(pathname.slice("/api/transcript/".length));
    const u = new URL(req.url, "http://local");
    const limit = Number(u.searchParams.get("limit") || "80");
    return json(res, 200, { talker, messages: readTranscript(talker, limit) });
  }

  if (pathname === "/api/calendar" && req.method === "GET") {
    const u = new URL(req.url, "http://local");
    const sync = u.searchParams.get("sync") === "1";
    if (sync) {
      // Start reconciliation in the background so the page can render local
      // data immediately even when Feishu or OAuth is slow/unavailable.
      startCalendarPull();
    }
    const summary = await calendarSummary();
    const feishuSync = calendarPullJob ? { ok: true, pending: true } : calendarPullResult;
    return json(res, 200, { ...summary, feishu_sync: feishuSync });
  }

  if (pathname.startsWith("/api/calendar/training/") && req.method === "PATCH") {
    const activity = decodeURIComponent(pathname.slice("/api/calendar/training/".length));
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const args = [
      "set",
      activity,
      "--done",
      body.done ? "true" : "false",
      "--intensity",
      String(body.intensity || "unknown"),
    ];
    if (body.date) args.push("--date", String(body.date));
    const result = runPythonJson(TRAINING_LOG_SCRIPT, args, 8000);
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (pathname === "/api/calendar/training-checkin" && req.method === "POST") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const args = ["set-batch", "--payload", JSON.stringify(body)];
    if (body.date) args.push("--date", String(body.date));
    const result = runPythonJson(TRAINING_LOG_SCRIPT, args, 10000);
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (pathname === "/api/calendar/training-readiness" && req.method === "PATCH") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const args = ["set-readiness", "--value", String(body.value || "unknown")];
    if (body.date) args.push("--date", String(body.date));
    const result = runPythonJson(TRAINING_LOG_SCRIPT, args, 8000);
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (pathname.startsWith("/api/calendar/events/") && req.method === "PATCH") {
    const uid = decodeURIComponent(pathname.slice("/api/calendar/events/".length));
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const result = runPythonJson(CALENDAR_DASHBOARD_SCRIPT, [
      "update-event",
      uid,
      "--fields",
      JSON.stringify(body),
    ]);
    if (!result.ok && result.reason === "not-found") return json(res, 404, result);
    if (!result.ok) return json(res, 400, result);
    return json(res, 200, { ...result, calendar: await calendarSummary() });
  }

  if (pathname.startsWith("/api/calendar/todos/") && req.method === "PATCH") {
    const uid = decodeURIComponent(pathname.slice("/api/calendar/todos/".length));
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const result = runPythonJson(CALENDAR_DASHBOARD_SCRIPT, [
      "update-todo",
      uid,
      "--fields",
      JSON.stringify(body),
    ]);
    if (!result.ok && result.reason === "not-found") {
      return json(res, 404, result);
    }
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, { ...result, calendar: await calendarSummary() });
  }

  if (pathname.match(/^\/api\/calendar\/todos\/[^/]+\/complete$/) && req.method === "POST") {
    const uid = decodeURIComponent(pathname.slice("/api/calendar/todos/".length, -"/complete".length));
    const result = runPythonJson(CALENDAR_DASHBOARD_SCRIPT, ["complete-todo", uid]);
    if (!result.ok && result.reason === "not-found") {
      return json(res, 404, result);
    }
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, { ...result, calendar: await calendarSummary() });
  }

  if (pathname.startsWith("/api/calendar/todos/") && req.method === "DELETE") {
    const uid = decodeURIComponent(pathname.slice("/api/calendar/todos/".length));
    const result = runPythonJson(CALENDAR_DASHBOARD_SCRIPT, ["delete-todo", uid]);
    if (!result.ok && result.reason === "not-found") {
      return json(res, 404, result);
    }
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, { ...result, calendar: await calendarSummary() });
  }

  if (pathname === "/api/calendar/sync-feishu" && req.method === "POST") {
    const result = await startCalendarPull();
    if (!result.ok) return json(res, 500, result);
    return json(res, 200, { ...result, calendar: await calendarSummary() });
  }

  if (pathname === "/api/integrations" && req.method === "GET") {
    return json(res, 200, {
      alipay_express: {
        status: "planned",
        note: "支付宝/菜鸟取快递待办 — 需官方开放 API 或手机自动化，暂未接入",
      },
    });
  }

  if (pathname === "/api/knowledge/uploads" && req.method === "GET") {
    try {
      const uploads = await listUploads(INGEST_UPLOAD_SCRIPT, 50);
      return json(res, 200, { ok: true, uploads });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (pathname === "/api/knowledge/upload" && req.method === "POST") {
    const ctype = req.headers["content-type"] || "";
    if (!ctype.includes("multipart/form-data")) {
      return json(res, 400, { error: "multipart/form-data required" });
    }
    const boundaryMatch = /boundary=(?:\"([^\"]+)\"|([^;\s]+))/i.exec(ctype);
    const boundary = boundaryMatch ? boundaryMatch[1] || boundaryMatch[2] : "";
    if (!boundary) return json(res, 400, { error: "missing boundary" });

    let buffer;
    try {
      buffer = await collectBodyBuffer(req);
    } catch (e) {
      return json(res, 413, { error: e.message || "upload too large" });
    }

    const parts = parseMultipart(buffer, boundary);
    const filePart = parts.find((p) => p.isFile && p.field === "file");
    if (!filePart || !filePart.data?.length) {
      return json(res, 400, { error: "file required" });
    }
    const tierPart = parts.find((p) => !p.isFile && p.field === "tier");
    const titlePart = parts.find((p) => !p.isFile && p.field === "title");
    const notePart = parts.find((p) => !p.isFile && p.field === "note");
    const tier = String(tierPart?.value || "work").trim();
    const title = String(titlePart?.value || "").trim();
    const note = String(notePart?.value || "").trim();
    const ext = safeExt(filePart.filename);
    if (!ALLOWED_EXT.has(ext)) {
      return json(res, 400, { error: `unsupported file type: ${ext || "(none)"}` });
    }

    const tmpDir = path.join(os.tmpdir(), "wechat-dash-upload");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
    const tmpPath = path.join(tmpDir, tmpName);
    try {
      fs.writeFileSync(tmpPath, filePart.data);
      const result = await ingestUploadedFile({
        workspace: WORKSPACE,
        tmpPath,
        tier,
        title: title || filePart.filename,
        note,
        ingestScript: INGEST_UPLOAD_SCRIPT,
      });
      triggerMemoryReindex();
      return json(res, 200, { ...result, reindex: "started" });
    } catch (e) {
      return json(res, 500, { error: e.message });
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const talker = body.talker || "dashboard-user";
    const normalized = trimChatHistory(messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || ""),
    })));
    const latestQuestion = uploadedSpreadsheetQuestion(normalized);
    const exactSpreadsheet = uploadedSpreadsheetResult(latestQuestion, ["work"]);
    const latestText = normalized.filter((m) => m.role === "user").at(-1)?.content || latestQuestion;
    const selectedModel = selectDashboardAgentModel(latestText);
    const routedMessages = injectChatCorpus(normalized, latestQuestion);
    if (selectedModel === REMOTE_AGENT_MODEL) {
      const lastUser = [...routedMessages].reverse().find((m) => m.role === "user");
      if (lastUser) lastUser.content = `${lastUser.content}${executionDirective(latestText)}`;
    }
    console.log(`[wechat-dashboard] selected agent model=${selectedModel} intent=${selectedModel === REMOTE_AGENT_MODEL ? "execute" : "conversation"}`);
    const payload = {
      model: selectedModel,
      // The browser already sends visible chat history.  A fresh gateway turn
      // prevents an older hidden OpenClaw session from ignoring a newly
      // uploaded corpus or leaking a prior file choice into this question.
      user: `dash:${talker}:turn:${Date.now()}`,
      stream: Boolean(body.stream),
      messages: routedMessages,
    };
    if (!payload.messages.length) return json(res, 400, { error: "messages required" });

    // Every non-streaming chat turn outlives the browser request. Complex file
    // review and provider fallback can legitimately exceed a proxy/browser
    // timeout, so return a durable handle immediately instead of tying agent
    // execution to the HTTP connection. Calendar writes remain receipt-gated
    // inside executeChatPayload/mutationReplyError.
    if (!body.stream) {
      const job = enqueueChatJob(payload, latestQuestion, exactSpreadsheet);
      return json(res, 202, {
        accepted: true,
        request_id: job.id,
        status: job.status,
        status_url: `/api/chat/jobs/${job.id}`,
      });
    }

    try {
      const gw = await gatewayRequest(payload, body.stream);
      if (body.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        gw.pipe(res);
        return;
      }
      const chunks = [];
      gw.on("data", (c) => chunks.push(c));
      gw.on("end", () => {
        try {
          const rawGatewayBody = Buffer.concat(chunks).toString("utf8");
          const parsed = JSON.parse(rawGatewayBody);
          const gatewayError = gatewayErrorDetails(gw.statusCode, parsed, rawGatewayBody);
          if (gatewayError) {
            return json(res, gatewayError.status, gatewayError);
          }
          let text = parsed?.choices?.[0]?.message?.content || "";
          let source;
          const injectedPrompt = payload.messages.filter((m) => m.role === "user").at(-1)?.content || "";
          if (exactSpreadsheet && needsGeminiAnswerFallback(text, injectedPrompt)) {
            text = exactSpreadsheet.answer;
            source = {
              type: "uploaded-spreadsheet-fallback",
              title: exactSpreadsheet.title,
              file: exactSpreadsheet.file,
            };
          } else if (needsGeminiAnswerFallback(text, injectedPrompt)) {
            const fallback = geminiFallbackAnswer(injectedPrompt);
            if (fallback?.answer) {
              text = fallback.answer;
              source = { type: "gemini-answer-fallback", model: fallback.model };
            }
          }
          const writeError = mutationReplyError(latestQuestion, text, calendarMutationIntent(payload.messages));
          if (writeError) return json(res, writeError.status, writeError);
          json(res, 200, { reply: text, raw: parsed, source });
        } catch (e) {
          json(res, 502, { error: String(e.message) });
        }
      });
    } catch (e) {
      const timedOut = /gateway timeout/i.test(String(e.message));
      return json(res, timedOut ? 504 : 502, {
        error: timedOut
          ? "Agent 执行超时，操作未取得可验收回执，不能视为成功。"
          : String(e.message),
        code: timedOut ? "agent_execution_timeout" : "gateway_request_failed",
      });
    }
    return;
  }

  if (pathname === "/api/chat/jobs" && req.method === "GET") {
    const jobs = [...chatJobs.values()]
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 20)
      .map((job) => ({
        request_id: job.id,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        result: job.status === "succeeded" ? job.result : undefined,
        error: job.status === "failed" ? job.error : undefined,
      }));
    return json(res, 200, { ok: true, jobs });
  }

  if (pathname.startsWith("/api/chat/jobs/") && req.method === "GET") {
    const id = decodeURIComponent(pathname.slice("/api/chat/jobs/".length));
    const job = chatJobs.get(id);
    if (!job) return json(res, 404, { error: "job not found", request_id: id });
    return json(res, 200, {
      ok: true,
      request_id: id,
      status: job.status,
      result: job.status === "succeeded" ? job.result : undefined,
      error: job.status === "failed" ? job.error : undefined,
      code: job.status === "failed" ? job.code : undefined,
      updated_at: job.updated_at,
    });
  }

  if (pathname === "/api/chat/deliver" && req.method === "POST") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const target = String(body.target || "");
    const text = String(body.text || "").trim();
    if (!['filehelper', 'test'].includes(target)) return json(res, 400, { error: "invalid target" });
    if (!text || text.length > 20000) return json(res, 400, { error: "invalid text" });
    try {
      return json(res, 200, await deliverAgentText(target, text));
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  if (pathname === "/api/chat/deliver-file" && req.method === "POST") {
    const raw = await collectBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const target = String(body.target || "");
    const file = String(body.file || "").trim();
    const displayName = String(body.display_name || "").trim();
    const caption = String(body.caption || "").trim();
    if (!["filehelper", "test"].includes(target)) return json(res, 400, { error: "invalid target" });
    if (!file || !path.isAbsolute(file)) return json(res, 400, { error: "invalid absolute file path" });
    if (displayName.length > 220 || caption.length > 2000) {
      return json(res, 400, { error: "display name or caption is too long" });
    }
    try {
      return json(
        res,
        200,
        await deliverAgentFile({ target, file, displayName: displayName || undefined, caption }),
      );
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", `http://${req.headers.host || "local"}`);
  const pathname = u.pathname;

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname);
    } catch (e) {
      json(res, 500, { error: String(e.message) });
    }
    return;
  }

  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!path.extname(filePath)) filePath = path.join(PUBLIC_DIR, "index.html");
  serveStatic(req, res, filePath);
});

if (require.main === module) {
  loadChatJobs();
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(
      `[wechat-dashboard] http://${LISTEN_HOST}:${LISTEN_PORT}  gateway=${GATEWAY}  model=${AGENT_MODEL}`,
    );
    if (!process.env.WECHAT_DASHBOARD_PASSWORD) {
      console.warn(
        "[wechat-dashboard] Set WECHAT_DASHBOARD_PASSWORD for production; using gateway token fallback.",
      );
    }
    runChatJobWorker().catch((err) => console.error("[wechat-dashboard] chat worker:", err.message));
  });
}

module.exports = {
  mediaBacklogCounts,
  mediaBusinessStatus,
  isMediaPostprocessJob,
  isAwaitingEvidence,
  canonicalQueueCounts,
  mediaQueueStatus,
  buildChatCorpus,
  capturedFileSnippet,
  fileCandidateScore,
  gatewayErrorDetails,
  injectChatCorpus,
  selectDashboardAgentModel,
  executionDirective,
  isCalendarMutationQuestion,
  calendarMutationIntent,
  mutationReplyError,
  reconcileLoadedChatJob,
  normalizeFileSearchTerms,
  trimChatHistory,
};
