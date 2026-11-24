#!/usr/bin/env node
/**
 * Poll aixed WeChat-Hook QueryDB -> WSL wechat-ingest.
 * WeChat 4.x: session.db SessionTable (no MicroMsg.db).
 * Legacy 3.x: MicroMsg.db MSG table.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { enrichEventMedia, enrichAppCardEvent, isMediaPayload, mediaPlaceholder, mediaKind, retryHdPendingManifest, preRegisterImageCdnPending, triggerDistill } = require("./wechat-pc-media");
const { shouldSkipMediaEnrich, resolveTalkerPolicy, displayNameForTalker, displayNameForSender } = require("./wechat-privacy");

// A user can send an image to the filehelper conversation for the agent to
// process. WeChat marks that message as outgoing, but it is still user input.
// Agent-generated outgoing messages must remain excluded from media ingest.
function shouldEnrichMediaEvent(event, content, messageType) {
  if (!isMediaPayload(content, messageType)) return false;
  if (!event?.is_send) return true;
  return event.talker === "filehelper" && event.agent_generated !== true;
}

const CONFIG_PATH =
  process.env.WECHAT_BRIDGE_CONFIG ||
  path.join(__dirname, "wechat-pc-bridge.config.json");
const DECOMPRESS_MSG_SCRIPT = path.join(__dirname, "scripts/decompress-wechat-msg-content.py");
const VOICE_ASR_SCRIPT = path.join(__dirname, "scripts/wechat-voice-asr.py");
const VOICE_ASR_PYTHON = path.join(__dirname, ".venv-voice/bin/python");
const VOICE_TYPE = 34;
const MEDIA_ENRICH_TIMEOUT_MS = Number(
  process.env.WECHAT_MEDIA_ENRICH_TIMEOUT_MS || "15000",
);
const VOICE_CACHE_DIR = path.join(
  process.env.OPENCLAW_WECHAT_WORKSPACE || path.join(os.homedir(), ".openclaw/workspace-wechat"),
  "media/voice",
);
const execFileAsync = promisify(execFile);

// GetAllDBName scans the Weixin process for SQLite handles.  Keep its result
// across polling cycles: repeatedly scanning a live client is both expensive
// and has proven unstable after the client has recovered from a crash.
const dbDiscovery = {
  plan: null,
  weixinHandle: "",
  nextRefreshAt: 0,
};
const DB_DISCOVERY_REFRESH_MS = Number(
  process.env.WECHAT_DB_DISCOVERY_REFRESH_MS || String(30 * 60 * 1000),
);
const DB_DISCOVERY_RETRY_MS = Number(
  // WeChat may expose QueryDB/status before its database handles are ready.
  // A five-minute retry gap silently leaves new messages outside the bridge
  // and makes the media Hook appear to have missed them. Retry quickly during
  // this startup window; operators can still override the interval explicitly.
  process.env.WECHAT_DB_DISCOVERY_RETRY_MS || String(5000),
);
// A session handle can appear before message_0.db during WeChat reconnect.
// Retry that incomplete plan quickly instead of caching it for five minutes.
const DB_DISCOVERY_INCOMPLETE_RETRY_MS = Number(
  process.env.WECHAT_DB_DISCOVERY_INCOMPLETE_RETRY_MS || "5000",
);

const DEFAULT_CONFIG = {
  hook_base_url: "http://127.0.0.1:30001",
  ingest_url: "http://127.0.0.1:18791/v1/wechat/event",
  ingest_token: "",
  poll_interval_ms: 2000,
  whitelist: [],
  auto_reply: false,
  auto_reply_whitelist: [],
  self_wxid: "",
  self_alias: "",
  pc_login_wxid: "",
  test_wxid: "",
  wechat_files_root: "",
  wechat_account_wxid: "",
  state_file: "",
  msg_databases: [],
};

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch (err) {
    console.error("[wechat-bridge] config read failed:", err.message);
  }
  if (!cfg.state_file) {
    cfg.state_file = path.join(__dirname, ".wechat-bridge-state.json");
  }
  if (!cfg.ingest_token && process.env.WECHAT_INGEST_TOKEN) {
    cfg.ingest_token = process.env.WECHAT_INGEST_TOKEN;
  }
  const accountsPath = path.join(__dirname, "wechat-accounts.json");
  try {
    if (fs.existsSync(accountsPath)) {
      const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
      if (!cfg.self_wxid && accounts.self?.wxid) cfg.self_wxid = accounts.self.wxid;
      if (!cfg.self_alias && accounts.self?.alias) cfg.self_alias = accounts.self.alias;
      if (!cfg.pc_login_wxid && accounts.pc_login?.wxid) cfg.pc_login_wxid = accounts.pc_login.wxid;
      if (!cfg.test_wxid && accounts.test_alt?.wxid) cfg.test_wxid = accounts.test_alt.wxid;
      if (!cfg.wechat_account_wxid && accounts.self?.wxid) {
        cfg.wechat_account_wxid = accounts.self.wxid;
      }
    }
  } catch {
    // ignore
  }
  if (!cfg.wechat_account_wxid && cfg.self_wxid) cfg.wechat_account_wxid = cfg.self_wxid;
  return cfg;
}

function loadState(cfg) {
  try {
    const s = JSON.parse(fs.readFileSync(cfg.state_file, "utf8"));
    s.last_local_id = s.last_local_id || {};
    s.last_session = s.last_session || {};
    s.recovered_file_postprocess = Array.isArray(s.recovered_file_postprocess)
      ? s.recovered_file_postprocess
      : [];
    for (const item of s.recovered_file_postprocess) {
      if (item.status === "processing") item.status = "pending";
    }
    return s;
  } catch {
    return {
      last_local_id: {},
      last_session: {},
      recovered_file_postprocess: [],
      bootstrapped: false,
      self_wxid: "",
    };
  }
}

function saveState(cfg, state) {
  fs.writeFileSync(cfg.state_file, JSON.stringify(state, null, 2), "utf8");
}

function recoveredFileKey(row) {
  const messageKey = row.message_key || row.id || [row.talker, row.local_id, row.ts].join("|");
  return `${messageKey}|${row.file_sha || "no-sha"}`;
}

function mediaRecoveryRow(event, msgRow, kind, reason) {
  const localId = Number(msgRow?.local_id ?? event?.local_id ?? 0);
  const ts = Number(event?.ts || (Number(msgRow?.create_time || 0) * 1000) || Date.now());
  const messageKey = event?.media_message_key ||
    [event?.talker || "", localId, Number(msgRow?.create_time || 0)].join("|");
  const original = msgRow?.message_content || event?.original_content ||
    (kind === "image" ? "[图片]" : ("[文件] " + (msgRow?.file_name || ""))).trim();
  return {
    id: messageKey,
    message_key: messageKey,
    talker: event?.talker || "",
    local_id: localId,
    server_id: msgRow?.server_id || msgRow?.msg_svr_id || event?.media_server_id || "",
    ts,
    type: Number(msgRow?.local_type ?? event?.type ?? (kind === "image" ? 3 : 49)),
    kind,
    original_content: original,
    content: event?.content || original,
    file_name: event?.media_file_name || msgRow?.file_name || "",
    file: event?.media_path || "",
    canonical_file: event?.media_path || "",
    file_sha: event?.media_file_sha256 || "",
    captured_tier: event?.media_captured_tier || null,
    thumbnail_sha256: event?.media_thumbnail_sha256 || null,
    middle_sha256: event?.media_middle_sha256 || null,
    middle_pending: event?.media_middle_pending ?? null,
    hd_pending: event?.media_hd_pending ?? null,
    hd_requested: event?.media_hd_requested ?? false,
    image_hash: event?.media_image_hash || null,
    status: reason,
    reason,
  };
}

function enqueueRecoveredFiles(cfg, state, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  state.recovered_file_postprocess = Array.isArray(state.recovered_file_postprocess)
    ? state.recovered_file_postprocess
    : [];
  const known = new Set(state.recovered_file_postprocess.map((item) => item.key));
  let added = 0;
  for (const row of rows) {
    const key = recoveredFileKey(row);
    if (known.has(key)) continue;
    state.recovered_file_postprocess.push({
      key,
      status: "pending",
      attempts: 0,
      next_at: 0,
      row,
      created_at: new Date().toISOString(),
    });
    known.add(key);
    added += 1;
  }
  // Retain completed receipts for idempotency, but cap state growth.
  if (state.recovered_file_postprocess.length > 500) {
    const unresolved = state.recovered_file_postprocess.filter(item => item.status !== "done");
    const receipts = state.recovered_file_postprocess.filter(item => item.status === "done");
    state.recovered_file_postprocess = [...receipts.slice(-500), ...unresolved];
  }
  if (added) saveState(cfg, state);
  return added;
}

const recoveryQueueRunning = new WeakSet();
async function processRecoveredFileQueue(cfg, state) {
  if (recoveryQueueRunning.has(state)) return false;
  recoveryQueueRunning.add(state);
  try { return await processRecoveredFileQueueUnlocked(cfg, state); }
  finally { recoveryQueueRunning.delete(state); }
}

async function processRecoveredFileQueueUnlocked(cfg, state) {
  const queue = state.recovered_file_postprocess || [];
  const item = queue.find((entry) =>
    (entry.status === "pending" || entry.status === "accepted") &&
    Number(entry.status === "accepted" ? entry.receipt_attempts || 0 : entry.attempts || 0) < 2 &&
    Date.now() >= Number(entry.next_at || 0),
  );
  if (!item) return false;
  if (item.status === "accepted" && item.request_id) {
    try {
      const { status, json } = await ingestStatusRequest(cfg, item.request_id);
      const remote = json?.job;
      if (status !== 200 || !remote) throw new Error(`receipt HTTP ${status}`);
      if (remote.status === "queued" || remote.status === "running") {
        item.next_at = Date.now() + 15000;
        saveState(cfg, state);
        return false;
      }
      if (remote.status !== "succeeded") {
        // The durable server owns retries and reconciliation. Never resubmit
        // an accepted operation simply because its receipt needs attention.
        item.status = "retry";
        item.last_error = `postprocess ${remote.status}: ${remote.last_error || "no receipt"}`;
        item.receipt = remote.result;
        saveState(cfg, state);
        return false;
      }
      const calendarResult = remote.result?.calendar?.result;
      const calendarItems = calendarResult?.kind === "multi"
        ? calendarResult.items : calendarResult ? [calendarResult] : [];
      const receiptMissing = remote.result?.calendar?.receipt_required === true && (
        calendarItems.length !== Number(remote.result.calendar.candidate_count || 0) ||
        calendarItems.some((entry) => entry?.ok !== true || !entry?.uid || entry?.feishu?.ok !== true || !entry?.feishu?.event_id)
      );
      if (receiptMissing) throw new Error("calendar receipt missing");
      item.status = "done";
      item.done_at = new Date().toISOString();
      item.receipt = remote.result;
      saveState(cfg, state);
      return true;
    } catch (err) {
      item.receipt_attempts = Number(item.receipt_attempts || 0) + 1;
      item.status = item.receipt_attempts >= 2 ? "retry" : "accepted";
      item.retry_exhausted = item.receipt_attempts >= 2;
      item.last_error = String(err.message || err).slice(0, 500);
      item.next_at = Date.now() + 15000;
      saveState(cfg, state);
      console.error(`[wechat-bridge] recovered-file receipt failed key=${item.key}: ${item.last_error}`);
      return false;
    }
  }
  item.status = "processing";
  item.started_at = new Date().toISOString();
  saveState(cfg, state);
  const row = item.row || {};
  const postprocessUrl = new URL(cfg.ingest_url);
  postprocessUrl.pathname = "/v1/wechat/postprocess";
  postprocessUrl.search = "";
  const event = {
    talker: row.talker,
    local_id: Number(row.local_id || 0),
    server_id: row.server_id || 0,
    ts: Number(row.ts || Date.now()),
    type: row.type || (row.kind === "image" ? 3 : row.kind === "video" ? 43 : 49),
    content: row.original_content || row.content || (row.kind === "image" ? "[图片]" : `[文件] ${row.file_name || ""}`.trim()),
    is_send: row.is_send === 1 || row.is_send === true ? 1 : 0,
    auto_reply: false,
    reply_policy: "postprocess-only",
    media_kind: ["image", "video"].includes(row.kind) ? row.kind : "file",
    media_recovered: true,
    media_message_key: row.message_key || row.id || "",
    media_local_id: Number(row.local_id || 0),
    media_server_id: row.server_id || 0,
    media_file_sha256: row.file_sha || "",
    media_file_name: row.file_name || "",
    media_file: row.file || "",
    media_canonical_file: row.canonical_file || row.file || "",
    // Recovery must preserve the same source evidence as live enrichment.
    // Do not turn missing/thumbnail bytes into a middle-source declaration.
    media_captured_tier: row.captured_tier || null,
    media_thumbnail_sha256: row.thumbnail_sha256 || null,
    media_middle_sha256: row.middle_sha256 || null,
    media_middle_pending: row.middle_pending ?? null,
    media_hd_pending: row.hd_pending ?? null,
    media_hd_requested: row.hd_requested ?? false,
    media_status: row.kind === "video" && row.file && row.file_sha ? "ready" : row.status || null,
    ...(row.kind === "video" ? { media_path: row.file, media_create_time: row.message_create_time } : {}),
    media_image_hash: row.image_hash || null,
  };
  try {
    const { status, json } = await ingestRequest(cfg, event, postprocessUrl.toString());
    const calendarResult = json?.calendar?.result;
    const calendarItems = calendarResult?.kind === "multi"
      ? calendarResult.items
      : calendarResult
        ? [calendarResult]
        : [];
    const calendarReceiptMissing = json?.calendar?.receipt_required === true && (
      calendarItems.length !== Number(json.calendar.candidate_count || 0) ||
      calendarItems.some((entry) => (
        entry?.ok !== true ||
        !entry?.uid ||
        entry?.feishu?.ok !== true ||
        !entry?.feishu?.event_id
      ))
    );
    const calendarRetryable =
      json?.retryable === true ||
      json?.calendar?.retryable === true ||
      json?.calendar?.result?.retryable === true ||
      json?.calendar?.result?.gate?.retryable === true;
    const calendarTechnicalFailure =
      calendarReceiptMissing ||
      calendarRetryable ||
      json?.vision_calendar?.ok === false ||
      json?.vision_calendar?.result?.ok === false ||
      (json?.calendar === false && !json?.vision_calendar) ||
      json?.calendar?.ok === false ||
      (json?.calendar?.result?.ok === false &&
        /error|failed|timeout|missing|unavailable/i.test(
          String(json.calendar.result.reason || json.calendar.result.error || ""),
        ));
    if (status === 202 && json?.accepted && json?.request_id) {
      item.status = "accepted";
      item.request_id = json.request_id;
      item.next_at = Date.now() + 15000;
      item.accepted_at = new Date().toISOString();
      saveState(cfg, state);
      return false;
    }
    if (status !== 200 || json?.ok === false || calendarTechnicalFailure) {
      throw new Error(`postprocess HTTP ${status}: ${JSON.stringify(json || {})}`);
    }
    item.status = "done";
    item.done_at = new Date().toISOString();
    item.receipt = json;
    saveState(cfg, state);
    console.log(
      `[wechat-bridge] recovered-file postprocessed key=${item.key} talker=${row.talker} local=${row.local_id}`,
    );
    return true;
  } catch (err) {
    item.attempts = Number(item.attempts || 0) + 1;
    item.status = item.attempts >= 2 ? "retry" : "pending";
    item.retry_exhausted = item.attempts >= 2;
    item.last_error = String(err.message || err).slice(0, 500);
    item.next_at = Date.now() + Math.min(30 * 60 * 1000, 15000 * 2 ** Math.min(item.attempts - 1, 7));
    saveState(cfg, state);
    console.error(
      `[wechat-bridge] recovered-file postprocess failed key=${item.key} attempts=${item.attempts}: ${item.last_error}`,
    );
    return false;
  }
}

const HOOK_STATUS_PATH = "/QueryDB/status";
const HOOK_CANDIDATES = [
  process.env.WECHAT_HOOK_BASE_URL,
  process.env.WECHAT_HOOK_HOST ? `http://${process.env.WECHAT_HOOK_HOST}:30001` : "",
  "http://127.0.0.1:30001",
].filter(Boolean);

function hookStatusRequest(baseUrl, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let url;
    try {
      url = new URL(HOOK_STATUS_PATH, baseUrl);
    } catch {
      finish(false);
      return;
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        finish(res.statusCode >= 200 && res.statusCode < 500);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.on("error", () => finish(false));
    req.end();
  });
}

async function resolveHookBaseUrl(cfg, { log = true } = {}) {
  const seen = new Set();
  const candidates = [...HOOK_CANDIDATES];
  if (cfg.hook_base_url) candidates.unshift(cfg.hook_base_url);
  for (const base of candidates) {
    const norm = String(base || "").replace(/\/$/, "");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (await hookStatusRequest(norm)) {
      if (cfg.hook_base_url !== norm && log) {
        console.log(`[wechat-bridge] hook resolved ${cfg.hook_base_url || "?"} -> ${norm}`);
      }
      cfg.hook_base_url = norm;
      return norm;
    }
  }
  if (log) {
    console.error(
      "[wechat-bridge] Hook unreachable (open WeChat on Windows first). Tried:",
      [...seen].join(", "),
    );
  }
  cfg.hook_base_url = cfg.hook_base_url || "http://127.0.0.1:30001";
  return cfg.hook_base_url;
}

function hookRequest(cfg, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, cfg.hook_base_url);
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text), text });
          } catch {
            resolve({ status: res.statusCode, json: null, text });
          }
        });
      },
    );
    req.on("error", (err) => {
      const db = body?.optDbName ? ` db=${body.optDbName}` : "";
      reject(new Error(`${method} ${apiPath}${db}: ${err.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function ingestRequest(cfg, event, endpoint = cfg.ingest_url) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const payload = JSON.stringify(event);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.ingest_token}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(url.pathname.endsWith("/postprocess") ? 15000 : 120000,
      () => req.destroy(new Error("ingest request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function ingestStatusRequest(cfg, requestId, endpoint = cfg.ingest_url) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const base = url.pathname.replace(/\/v1\/wechat\/[^/]+$/, "");
    const statusPath = `${base}/v1/wechat/postprocess/${encodeURIComponent(requestId)}`;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: statusPath,
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.ingest_token}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (err) { reject(err); }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error("ingest receipt timeout")));
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function inWhitelist(cfg, talker) {
  if (!cfg.whitelist?.length) return true;
  return cfg.whitelist.includes(talker);
}

function parseGroupSender(content, talker) {
  if (!content || !talker?.includes("@chatroom")) return "";
  const m = String(content).match(/^(wxid_[^:\n]+|[a-zA-Z0-9_-]+):\n/);
  return m ? m[1] : "";
}

function shouldAutoReply(cfg, talker) {
  if (cfg.auto_reply_mode === "policy") return true;
  if (cfg.auto_reply === true) return true;
  return (cfg.auto_reply_whitelist || []).includes(talker);
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function executeSql(cfg, dbName, sql) {
  const { status, json } = await hookRequest(cfg, "POST", "/QueryDB/execute", {
    optDbName: dbName,
    SQL: sql,
  });
  if (status !== 200 || !json || json.status !== 0 || !Array.isArray(json.data)) {
    const err = json?.desc || json?.msg || `query failed (HTTP ${status})`;
    throw new Error(`${dbName}: ${err}`);
  }
  return json.data;
}

async function listOpenDatabases(cfg) {
  const { status, json } = await hookRequest(cfg, "POST", "/QueryDB/GetAllDBName", {});
  if (status !== 200 || !Array.isArray(json)) {
    throw new Error(`GetAllDBName failed (HTTP ${status}); discovery is unavailable, not empty`);
  }
  return json.map((r) => r.dbName || r.dbname).filter(Boolean);
}

async function discoverDatabasePlan(cfg) {
  try {
    const names = await listOpenDatabases(cfg);
    const plan = classifyDatabases(names);
    if (plan.session || plan.message.length || plan.legacy.length) return plan;
  } catch (err) {
    console.error("[wechat-bridge]", err.message);
  }
  // Enumeration can abort after finding valid handles. Probe actual read
  // capability without forcing another process-memory scan for each poll.
  const names = [];
  const candidates = new Set([
    ...(cfg.msg_databases || []),
    ...(dbDiscovery.plan?.message || []),
    "message_0.db", "message_1.db", "message_2.db", "message_3.db",
    "session.db", "media_0.db",
  ]);
  for (const name of candidates) {
    try { await executeSql(cfg, name, "SELECT 1 AS probe"); names.push(name); }
    catch { /* Only successfully queried handles may enter the plan. */ }
  }
  const plan = classifyDatabases(names);
  if (!plan.message.length && !plan.session) throw new Error("no queryable database handles");
  plan.direct_probe = true;
  return plan;
}

function classifyDatabases(names) {
  const legacy = [];
  const message = [];
  const media = [];
  let session = null;
  for (const name of names) {
    if (/^MicroMsg\.db$/i.test(name)) legacy.push(name);
    else if (/^message(_\d+)?\.db$/i.test(name)) message.push(name);
    else if (/^media(_\d+)?\.db$/i.test(name)) media.push(name);
    else if (/^session\.db$/i.test(name)) session = name;
  }
  return { legacy, message, media, session };
}

async function getSelfWxid(cfg) {
  if (cfg.self_wxid) return cfg.self_wxid;
  if (cfg.pc_login_wxid) return cfg.pc_login_wxid;
  try {
    const { json } = await hookRequest(cfg, "POST", "/GetSelfProfile", {});
    return json?.wxid || "";
  } catch {
    return "";
  }
}

function applyAccountMeta(cfg, state) {
  state.self_wxid = cfg.self_wxid || state.self_wxid || "";
  state.self_alias = cfg.self_alias || state.self_alias || "";
  state.pc_login_wxid = cfg.pc_login_wxid || state.pc_login_wxid || "";
  state.test_wxid = cfg.test_wxid || state.test_wxid || "";
}

function msgTableForTalker(talker) {
  const hash = crypto.createHash("md5").update(talker, "utf8").digest("hex");
  return `Msg_${hash}`;
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  return undefined;
}

function parseSummary(summary) {
  if (!summary) return "";
  const s = String(summary);
  const idx = s.indexOf(":\n");
  return idx >= 0 ? s.slice(idx + 2) : s;
}

function decodeCompressedTextMessage(raw, localType) {
  const text = String(raw || "");
  // V4 stores ordinary text messages as zstd-frame hex. File/app messages use
  // a different binary payload and must remain untouched for media handling.
  if (![1, 10000].includes(Number(localType))) return text;
  if (!/^28B52FFD[0-9A-F]+$/i.test(text) || text.length % 2 !== 0) return text;
  try {
    const decoded = execFileSync("python3", [DECOMPRESS_MSG_SCRIPT, text], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
    return decoded || text;
  } catch {
    return text;
  }
}

function voiceCacheStem(talker, msgRow) {
  const stable = [
    talker,
    Number(msgRow.local_id) || 0,
    String(msgRow.server_id || ""),
    Number(msgRow.create_time) || 0,
  ].join("|");
  return crypto.createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 24);
}

async function findVoiceBlob(cfg, mediaDbs, talker, msgRow) {
  const localId = Number(msgRow.local_id) || 0;
  const createTime = Number(msgRow.create_time) || 0;
  for (const dbName of mediaDbs || []) {
    try {
      const rows = await executeSql(
        cfg,
        dbName,
        `SELECT hex(v.voice_data) AS voice_hex, v.svr_id, v.create_time, v.local_id ` +
          `FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id ` +
          `WHERE n.user_name=${sqlQuote(talker)} AND v.local_id=${localId} ` +
          (createTime ? `AND v.create_time=${createTime} ` : "") +
          `LIMIT 1`,
      );
      const voiceHex = String(rows[0]?.voice_hex || "");
      if (voiceHex && voiceHex.length % 2 === 0) {
        return { dbName, row: rows[0], data: Buffer.from(voiceHex, "hex") };
      }
    } catch {
      // Media shards may not contain this conversation.
    }
  }
  return null;
}

async function transcribeVoiceEvent(cfg, event, msgRow, mediaDbs) {
  fs.mkdirSync(VOICE_CACHE_DIR, { recursive: true });
  const stem = voiceCacheStem(event.talker, msgRow);
  const silkPath = path.join(VOICE_CACHE_DIR, `${stem}.silk`);
  const resultPath = path.join(VOICE_CACHE_DIR, `${stem}.asr.json`);

  let result = null;
  if (fs.existsSync(resultPath)) {
    try {
      result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch {
      result = null;
    }
  }

  if (!result?.text) {
    let found = null;
    for (let attempt = 0; attempt < 4 && !found; attempt += 1) {
      found = await findVoiceBlob(cfg, mediaDbs, event.talker, msgRow);
      if (!found && attempt < 3) await sleep(400);
    }
    if (!found?.data?.length) {
      throw new Error(`voice blob not committed localId=${msgRow.local_id}`);
    }
    if (!fs.existsSync(silkPath)) fs.writeFileSync(silkPath, found.data);
    const { stdout } = await execFileAsync(
      VOICE_ASR_PYTHON,
      [VOICE_ASR_SCRIPT, silkPath, "--output", resultPath],
      {
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, WECHAT_VOICE_ASR_MODEL: process.env.WECHAT_VOICE_ASR_MODEL || "small" },
      },
    );
    const lastLine = String(stdout || "").trim().split("\n").filter(Boolean).pop();
    result = JSON.parse(lastLine || fs.readFileSync(resultPath, "utf8"));
  }

  if (!result?.text) throw new Error("empty local voice transcript");
  event.content = `[语音转写] ${String(result.text).trim()}`;
  event.media_kind = "voice";
  event.media_status = "voice_transcribed_local";
  event.media_path = silkPath;
  event.voice_asr_model = result.model || "small";
  event.voice_duration_seconds = Number(result.duration) || null;
  event.voice_language_probability = Number(result.language_probability) || null;
}

/** Prefer the message database's sender identity; XML alone is ambiguous. */
function isOutgoingV4(row, selfSenderId = null) {
  if (selfSenderId != null && row.real_sender_id != null) {
    return String(row.real_sender_id) === String(selfSenderId);
  }
  const src = decodeCompressedTextMessage(pick(row, "source") || "", 1);
  if (src.includes("<fr>1</fr>")) return true;
  return false;
}

async function syncSessionCursor(cfg, state, sessionDb, talker) {
  if (!sessionDb || !talker) return;
  try {
    const rows = await executeSql(
      cfg,
      sessionDb,
      `SELECT last_timestamp, last_msg_locald_id FROM SessionTable WHERE username=${sqlQuote(talker)}`,
    );
    const row = rows[0];
    if (!row) return;
    state.last_session[talker] = {
      ts: Number(row.last_timestamp) || 0,
      localId: Number(row.last_msg_locald_id) || 0,
    };
    saveState(cfg, state);
  } catch {
    // ignore
  }
}

async function fetchIncomingMessages(cfg, messageDbs, talker, afterLocalId) {
  const table = msgTableForTalker(talker);
  for (const dbName of messageDbs) {
    try {
      const selfWxid = cfg.wechat_account_wxid || cfg.self_wxid || cfg.pc_login_wxid;
      const selfRows = selfWxid ? await executeSql(cfg, dbName,
        `SELECT rowid AS sender_id FROM Name2Id WHERE user_name=${sqlQuote(selfWxid)} LIMIT 1`) : [];
      const selfSenderId = selfRows[0]?.sender_id ?? null;
      const sql =
        `SELECT local_id, CAST(server_id AS TEXT) AS server_id, create_time, local_type, message_content, ` +
        `real_sender_id, (SELECT user_name FROM Name2Id WHERE rowid=real_sender_id) AS sender_wxid, source, packed_info_data ` +
        `FROM ${table} WHERE local_id > ${Number(afterLocalId) || 0} ` +
        `ORDER BY local_id ASC LIMIT 30`;
      const rows = await executeSql(cfg, dbName, sql);
      let maxLocalId = Number(afterLocalId) || 0;
      const incoming = [];
      for (const row of rows) {
        const localId = Number(pick(row, "local_id", "localId")) || 0;
        maxLocalId = Math.max(maxLocalId, localId);
        const isSend = isOutgoingV4(row, selfSenderId) ? 1 : 0;
        const rawContent = pick(row, "message_content", "StrContent") || "";
        const localType = Number(pick(row, "local_type", "Type")) || 0;
        const content = decodeCompressedTextMessage(rawContent, localType);
        incoming.push({
          local_id: localId,
          server_id: pick(row, "server_id", "MsgSvrID"),
          create_time: Number(pick(row, "create_time", "CreateTime")) || 0,
          local_type: localType,
          content,
          // Preserve the DB payload for file/image metadata extraction while
          // exposing decoded ordinary text to the transcript and Agent.
          message_content: rawContent,
          decoded_message_content: content,
          packed_info_data: pick(row, "packed_info_data") || "",
          sender: String(pick(row, "sender_wxid") || parseGroupSender(content, talker) || ""),
          source: decodeCompressedTextMessage(pick(row, "source") || "", 1),
          is_send: isSend,
        });
      }
      if (incoming.length) {
        return { incoming, max_local_id: maxLocalId };
      }
      // A successful empty query is not permission to advance the SessionTable
      // cursor.  On WeChat startup session.db can expose a newer local id a few
      // seconds before the corresponding message row is visible.  Advancing
      // here would permanently skip that row.
      return { incoming: [], max_local_id: Number(afterLocalId) || 0 };
    } catch {
      // table/db may not be open yet
    }
  }
  return null;
}

async function fetchLatestIncomingMessage(cfg, messageDbs, talker, afterLocalId) {
  const batch = await fetchIncomingMessages(cfg, messageDbs, talker, afterLocalId);
  if (!batch?.incoming?.length) return batch;
  return { ...batch.incoming[0], max_local_id: batch.max_local_id };
}

async function queryLegacyMessages(cfg, dbName, afterLocalId, limit = 30) {
  const sql =
    `SELECT localId, MsgSvrID, Type, IsSender, CreateTime, StrTalker, StrContent ` +
    `FROM MSG WHERE localId > ${Number(afterLocalId) || 0} AND IsSender = 0 ` +
    `ORDER BY localId ASC LIMIT ${limit}`;
  return executeSql(cfg, dbName, sql);
}

function legacyRowToEvent(row, dbName) {
  return {
    source: "pc-hook",
    db: dbName,
    local_id: row.localId,
    msg_svr_id: row.MsgSvrID,
    type: row.Type,
    is_send: row.IsSender,
    ts: Number(row.CreateTime) * 1000,
    talker: row.StrTalker,
    content: row.StrContent ?? "",
    auto_reply: true,
  };
}

function sessionRowToEvent(row, dbName, contentOverride) {
  const talker = row.username;
  const tsSec = Number(row.last_timestamp) || 0;
  const content = contentOverride ?? parseSummary(row.summary);
  return {
    source: "pc-hook",
    db: dbName,
    local_id: Number(row.last_msg_locald_id || row.last_msg_local_id) || 0,
    msg_svr_id: row.unread_first_msg_srv_id,
    type: row.last_msg_type,
    is_send: 0,
    ts: tsSec * 1000,
    talker,
    content,
    sender: row.last_msg_sender || "",
    auto_reply: true,
  };
}

async function bootstrapLegacy(cfg, state, legacyDbs) {
  let maxId = 0;
  for (const dbName of legacyDbs) {
    try {
      const rows = await executeSql(cfg, dbName, "SELECT MAX(localId) AS m FROM MSG");
      const m = rows[0]?.m;
      if (m != null) maxId = Math.max(maxId, Number(m) || 0);
    } catch {
      // ignore
    }
  }
  for (const dbName of legacyDbs) state.last_local_id[dbName] = maxId;
  state.mode = "legacy_msg";
  state.bootstrapped = true;
  saveState(cfg, state);
  console.log(`[wechat-bridge] legacy bootstrap, skip localId<=${maxId}`);
}

async function bootstrapSession(cfg, state, sessionDb) {
  if (!state.self_wxid) state.self_wxid = await getSelfWxid(cfg);
  const rows = await executeSql(
    cfg,
    sessionDb,
    "SELECT username, last_timestamp, last_msg_locald_id, summary, last_msg_sender FROM SessionTable",
  );
  for (const row of rows) {
    const u = row.username;
    if (!u) continue;
    state.last_session[u] = {
      ts: Number(row.last_timestamp) || 0,
      localId: Number(row.last_msg_locald_id) || 0,
    };
  }
  state.mode = "v4_session";
  state.bootstrapped = true;
  saveState(cfg, state);
  console.log(
    `[wechat-bridge] v4 session bootstrap (${rows.length} sessions), self=${state.self_wxid || "?"}`,
  );
}

async function bootstrap(cfg, state, plan) {
  if (plan.legacy.length) {
    await bootstrapLegacy(cfg, state, plan.legacy);
    return;
  }
  if (plan.session) {
    await bootstrapSession(cfg, state, plan.session);
    return;
  }
  console.log("[wechat-bridge] no message/session DB open yet — will retry bootstrap");
}

async function hookReady(cfg) {
  const status = await hookRequest(cfg, "GET", "/QueryDB/status");
  if (!status.json?.hWeixin) return { ready: false, reason: "no_hook" };
  const weixinHandle = String(status.json.hWeixin);
  const now = Date.now();
  const weixinChanged = dbDiscovery.weixinHandle !== weixinHandle;
  const needsRefresh =
    weixinChanged ||
    now >= dbDiscovery.nextRefreshAt;

  if (needsRefresh) {
    if (weixinChanged) dbDiscovery.plan = null;
    dbDiscovery.weixinHandle = weixinHandle;
    try {
      dbDiscovery.plan = await discoverDatabasePlan(cfg);
      const names = [...dbDiscovery.plan.legacy, ...dbDiscovery.plan.message,
        ...dbDiscovery.plan.media, ...(dbDiscovery.plan.session ? [dbDiscovery.plan.session] : [])];
      const incompleteMessagePlan = Boolean(dbDiscovery.plan.session && !dbDiscovery.plan.message.length);
      dbDiscovery.nextRefreshAt = now + (
        incompleteMessagePlan ? DB_DISCOVERY_INCOMPLETE_RETRY_MS : DB_DISCOVERY_REFRESH_MS
      );
      console.log(
        `[wechat-bridge] refreshed DB discovery${dbDiscovery.plan.direct_probe ? " (verified direct probes)" : ""}: ${names.join(", ") || "(none)"}`,
      );
      if (incompleteMessagePlan) {
        console.error(
          "[wechat-bridge] session.db is open but no message_*.db is visible; " +
          `retrying DB discovery in ${DB_DISCOVERY_INCOMPLETE_RETRY_MS}ms`,
        );
      }
    } catch (err) {
      // A failing discovery request must not turn into a rapid retry loop
      // against the client's in-process SQLite state.
      dbDiscovery.nextRefreshAt = now + DB_DISCOVERY_RETRY_MS;
      console.error("[wechat-bridge] DB discovery deferred:", err.message);
    }
  }
  return {
    ready: true,
    reason: dbDiscovery.plan ? "db" : "hook_loaded",
    plan: dbDiscovery.plan || classifyDatabases([]),
  };
}

async function forwardEvent(cfg, state, sessionDb, event) {
  const auto = shouldAutoReply(cfg, event.talker);
  event.auto_reply = auto;
  event.reply_policy = auto ? "auto" : "manual";
  if (cfg.self_wxid) event.self_wxid = cfg.self_wxid;
  if (cfg.pc_login_wxid) event.pc_login_wxid = cfg.pc_login_wxid;
  if (cfg.self_alias) event.self_alias = cfg.self_alias;
  const { status: st, json: resp } = await ingestRequest(cfg, event);
  if (st !== 200) {
    throw new Error(`ingest HTTP ${st}: ${resp?.error || "delivery failed"}`);
  }
  console.log(
    `[wechat-bridge] ingested talker=${event.talker} localId=${event.local_id}`,
  );
  if (resp?.reply?.text) {
    const delay = Number(resp.reply.delay_ms) || 3000;
    await sleep(delay);
    const { json: sent } = await hookRequest(cfg, "POST", "/SendTextMsg", {
      wxidorgid: resp.reply.talker || event.talker,
      msg: resp.reply.text,
    });
    console.log(`[wechat-bridge] sent reply ret=${sent?.ret} talker=${event.talker}`);
    await sleep(500);
    await syncSessionCursor(cfg, state, sessionDb, event.talker);
  }
}

async function pollLegacy(cfg, state, legacyDbs) {
  for (const dbName of legacyDbs) {
    const after = state.last_local_id[dbName] || 0;
    let rows;
    try {
      rows = await queryLegacyMessages(cfg, dbName, after);
    } catch {
      continue;
    }
    for (const row of rows) {
      const localId = Number(row.localId) || 0;
      state.last_local_id[dbName] = Math.max(state.last_local_id[dbName] || 0, localId);
      const talker = row.StrTalker;
      if (!talker || !inWhitelist(cfg, talker)) continue;
      try {
        await forwardEvent(cfg, state, null, legacyRowToEvent(row, dbName));
      } catch (err) {
        console.error("[wechat-bridge] forward failed:", err.message);
      }
    }
  }
  saveState(cfg, state);
}

async function pollMessageDatabases(cfg, state, messageDbs, mediaDbs) {
  // Read each conversation's latest authoritative message rather than relying
  // on the optional session.db index. Existing cursors remain unchanged.
  state.message_recovery_since ||= Math.max(0, ...Object.values(state.last_session)
    .map((cursor) => Number(cursor.ts) || 0));
  for (const dbName of messageDbs) {
    const users = await executeSql(cfg, dbName, "SELECT user_name FROM Name2Id");
    const tables = new Set((await executeSql(cfg, dbName,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"))
      .map((row) => row.name));
    const talkers = users.map((row) => row.user_name)
      .filter((talker) => talker && inWhitelist(cfg, talker) && tables.has(msgTableForTalker(talker)));
    for (let i = 0; i < talkers.length; i += 20) {
      const sql = talkers.slice(i, i + 20).map((talker) =>
        `SELECT ${sqlQuote(talker)} AS username, create_time AS last_timestamp, ` +
        `local_id AS last_msg_locald_id, local_type AS last_msg_type FROM (` +
        `SELECT create_time, local_id, local_type FROM ${msgTableForTalker(talker)} ` +
        "ORDER BY local_id DESC LIMIT 1)").join(" UNION ALL ");
      const rows = await executeSql(cfg, dbName, sql);
      for (const row of rows) {
        if (state.last_session[row.username]) continue;
        // A previously unseen conversation must recover messages since the
        // outage, without replaying its entire historical conversation.
        const baseline = await executeSql(cfg, dbName,
          `SELECT MAX(local_id) AS id FROM ${msgTableForTalker(row.username)} ` +
          `WHERE create_time < ${state.message_recovery_since}`);
        state.last_session[row.username] = {
          ts: state.message_recovery_since - 1, localId: Number(baseline[0]?.id) || 0,
        };
      }
      await pollSession(cfg, state, null, [dbName], mediaDbs, rows);
    }
  }
}

async function pollSession(cfg, state, sessionDb, messageDbs, mediaDbs, messageRows = null) {
  // During WeChat reconnect session.db is commonly opened before message_0.db.
  // The SessionTable summary is only the last message, so using it while the
  // message DB is unavailable destroys the backlog boundary and skips every
  // earlier message in the outage window.  Wait for the authoritative message
  // table and leave all per-chat cursors untouched.
  if (!messageDbs.length) {
    return;
  }
  let rows;
  try {
    rows = messageRows ?? await executeSql(
      cfg,
      sessionDb,
      "SELECT username, last_timestamp, last_msg_locald_id, unread_first_msg_srv_id, " +
        "summary, last_msg_sender, last_msg_type FROM SessionTable",
    );
  } catch (err) {
    console.error("[wechat-bridge] session query failed:", err.message);
    // Do not keep using a stale database plan after a transient Hook/SQLite
    // failure. The next poll must rediscover the currently open handles.
    dbDiscovery.plan = null;
    dbDiscovery.nextRefreshAt = Date.now() + DB_DISCOVERY_INCOMPLETE_RETRY_MS;
    return;
  }

  console.log(
    `[wechat-bridge] session poll rows=${rows.length} ` +
    `messageDbs=${messageDbs.join(",") || "(none)"}`,
  );

  for (const row of rows) {
    const talker = row.username;
    if (!talker || !inWhitelist(cfg, talker)) continue;

    const ts = Number(row.last_timestamp) || 0;
    const localId = Number(row.last_msg_locald_id) || 0;
    const prev = state.last_session[talker] || { ts: 0, localId: 0 };

    const isNew = ts > prev.ts || (ts === prev.ts && localId > prev.localId);
    if (!isNew) continue;

    let content = parseSummary(row.summary);
    let eventLocalId = localId;
    let incomingBatch = null;

    incomingBatch = await fetchIncomingMessages(cfg, messageDbs, talker, prev.localId);
    if (!incomingBatch?.incoming?.length) {
      // Do not trust a newer SessionTable id until its message row is visible.
      // The next poll will retry and preserve the exact arrival sequence.
      continue;
    }

    console.log(
      `[wechat-bridge] incoming talker=${talker} prevLocalId=${prev.localId} ` +
      `sessionLocalId=${localId} fetched=${incomingBatch.incoming.length} ` +
      `maxLocalId=${incomingBatch.max_local_id}`,
    );

    const toProcess = incomingBatch?.incoming?.length
      ? incomingBatch.incoming
      : [{ content, local_id: eventLocalId, local_type: row.last_msg_type, create_time: ts }];

    let deliveredId = prev.localId;
    let deliveredTs = prev.ts;
    for (const msgRow of toProcess) {
      content = msgRow.content;
      eventLocalId = msgRow.local_id || localId;
      if (!content) { deliveredId = eventLocalId; continue; }

      try {
        const event = sessionRowToEvent(row, sessionDb, content);
        event.local_id = eventLocalId;
        event.ts = (Number(msgRow.create_time) || ts) * 1000;
        event.is_send = Number(msgRow.is_send || 0);
        event.agent_generated = Boolean(
          event.is_send && /^【agent】[：:]/i.test(String(content || "").trim()),
        );
        if (msgRow.local_type != null) event.type = msgRow.local_type;
        const msgSource = pick(msgRow, "source") || "";
        if (msgSource && !String(msgSource).match(/^[0-9A-Fa-f]{32,}$/)) {
          event.msg_source = msgSource;
        }
        event.nickname = displayNameForTalker(
          event.talker,
          cfg.group_display_names?.[event.talker] || event.nickname || "",
          cfg.group_display_names || {},
        );
        const groupSender = msgRow.sender || parseGroupSender(content, event.talker);
        if (groupSender) {
          event.sender = groupSender;
          event.sender_display = displayNameForSender(groupSender, "", event.talker);
        }
        const effectiveType = Number(msgRow.local_type ?? row.last_msg_type);
        if (mediaKind(effectiveType) === "app_card") {
          await enrichAppCardEvent(cfg, event, msgRow);
        } else if (effectiveType === VOICE_TYPE) {
          try {
            await transcribeVoiceEvent(cfg, event, msgRow, mediaDbs);
            console.log(
              `[wechat-bridge] voice transcribed talker=${event.talker} localId=${event.local_id}`,
            );
          } catch (voiceErr) {
            event.content = "[语音：本地转写暂不可用]";
            event.media_kind = "voice";
            event.media_status = "voice_transcribe_failed";
            event.voice_error = String(voiceErr.message || voiceErr).slice(0, 180);
            console.error(
              `[wechat-bridge] voice transcribe failed talker=${event.talker} ` +
                `localId=${event.local_id}: ${event.voice_error}`,
            );
          }
        } else if (shouldEnrichMediaEvent(event, content, effectiveType)) {
          const kind = mediaKind(msgRow.local_type ?? row.last_msg_type);
          const skip = shouldSkipMediaEnrich(event.talker, event.nickname, kind);
          if (skip.skip) {
            event.media_kind = kind;
            event.content = mediaPlaceholder(msgRow.local_type ?? row.last_msg_type);
            event.media_status = "skipped_policy";
            event.media_skip_reason = skip.reason;
          } else {
            // Register the exact CDN identity with the Hook before resolving
            // the local cache.  This is a non-blocking source acquisition
            // request for the native middle tier; it never waits for HD or
            // spends a vision attempt.
            if (kind === "image") {
              preRegisterImageCdnPending(cfg, event.talker, msgRow).catch((err) => {
                console.error("[wechat-bridge] native middle registration failed:", String(err?.message || err).slice(0, 180));
              });
            }
            const enrichPromise = Promise.resolve().then(() =>
              enrichEventMedia(cfg, event, msgRow),
            );
            // The resolver may still finish and update the manifest after the
            // live event is accepted. Attach a handler immediately so a late
            // rejection cannot become an unhandled process error.
            enrichPromise.catch((enrichErr) => {
              console.error(
                "[wechat-bridge] media enrich late failure talker=" + event.talker +
                  " localId=" + event.local_id + ": " +
                  String(enrichErr?.message || enrichErr).slice(0, 180),
              );
            });
            let timeoutHandle;
            const timeoutPromise = new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => {
                const timeoutErr = new Error(
                  "media enrichment exceeded " + MEDIA_ENRICH_TIMEOUT_MS + "ms",
                );
                timeoutErr.code = "MEDIA_ENRICH_TIMEOUT";
                reject(timeoutErr);
              }, MEDIA_ENRICH_TIMEOUT_MS);
            });
            try {
              await Promise.race([enrichPromise, timeoutPromise]);
            } catch (mediaErr) {
              const timedOut = mediaErr?.code === "MEDIA_ENRICH_TIMEOUT";
              const recoveryStatus = timedOut
                ? "media_enrich_timeout"
                : "media_enrich_failed";
              event.content = mediaPlaceholder(msgRow.local_type ?? row.last_msg_type);
              event.media_kind = kind;
              event.media_status = recoveryStatus;
              event.media_error = String(mediaErr?.message || mediaErr).slice(0, 240);
              const recovery = mediaRecoveryRow(event, msgRow, kind, recoveryStatus);
              const added = enqueueRecoveredFiles(cfg, state, [recovery]);
              console.error(
                "[wechat-bridge] " + recoveryStatus + " talker=" + event.talker +
                  " localId=" + event.local_id +
                  " queued_recovery=" + (added > 0 ? "yes" : "existing"),
              );
            } finally {
              clearTimeout(timeoutHandle);
            }
          }
        }
        await forwardEvent(cfg, state, sessionDb, event);
        deliveredId = eventLocalId;
        deliveredTs = Math.max(deliveredTs, Number(msgRow.create_time) || ts);
      } catch (err) {
        console.error("[wechat-bridge] forward failed:", err.message);
        break; // Never acknowledge a failed message or skip past it.
      }
    }

    if (deliveredId > prev.localId) {
      state.last_session[talker] = {
        ts: deliveredTs,
        localId: deliveredId,
      };
    }
  }
  saveState(cfg, state);
}

async function pollOnce(cfg, state) {
  const ready = await hookReady(cfg);
  if (!ready.ready) {
    console.log("[wechat-bridge] Hook not ready, waiting...");
    return;
  }

  const plan = ready.plan;
  if (plan.message.length === 0 && !plan.session && plan.legacy.length === 0) {
    console.log("[wechat-bridge] no usable message/session DB in cached discovery");
  }

  if (!state.bootstrapped) {
    await bootstrap(cfg, state, plan);
    return;
  }

  if (state.mode === "legacy_msg" && plan.legacy.length) {
    await pollLegacy(cfg, state, plan.legacy);
    return;
  }

  if (plan.session) {
    await pollSession(cfg, state, plan.session, plan.message, plan.media);
    enqueueRecoveredFiles(cfg, state, await retryHdPendingManifest(cfg, { filesOnly: true }));
    await processRecoveredFileQueue(cfg, state);
    return;
  }

  if (plan.message.length) {
    await pollMessageDatabases(cfg, state, plan.message, plan.media);
    return;
  }

  if (plan.legacy.length) {
    state.bootstrapped = false;
    await bootstrap(cfg, state, plan);
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.ingest_token) {
    console.error("[wechat-bridge] set ingest_token in wechat-pc-bridge.config.json");
    process.exit(1);
  }
  await resolveHookBaseUrl(cfg);
  const state = loadState(cfg);
  applyAccountMeta(cfg, state);
  saveState(cfg, state);
  console.log(`[wechat-bridge] hook=${cfg.hook_base_url} ingest=${cfg.ingest_url}`);
  console.log(
    `[wechat-bridge] accounts self=${cfg.self_wxid || "?"} alias=${cfg.self_alias || "?"} pc=${cfg.pc_login_wxid || "?"} test=${cfg.test_wxid || "?"}`,
  );
  console.log(
    `[wechat-bridge] whitelist=${cfg.whitelist.length ? cfg.whitelist.join(",") : "(all)"} auto_reply=${cfg.auto_reply ? "all" : (cfg.auto_reply_whitelist || []).join(",") || "off"}`,
  );

  // File rows and resource rows are committed asynchronously by Weixin. Keep
  // media recovery independent of a potentially long full SessionTable pass.
  // The resolver itself retries only unresolved rows and has an internal
  // cooldown, so this does not touch completed files or the HD image path.
  let imageRetryRunning = false;
  const imageRetryTimer = setInterval(async () => {
    if (imageRetryRunning) return;
    imageRetryRunning = true;
    try {
      enqueueRecoveredFiles(cfg, state, await retryHdPendingManifest(cfg, { passiveOnly: true }));
      // Processing receipts can wait on ingest/network. Release the image
      // scan guard immediately so that it cannot stall source discovery.
      void processRecoveredFileQueue(cfg, state).catch(err => {
        console.error("[wechat-bridge] image recovery queue failed:", err.message);
      });
    } catch (err) {
      console.error("[wechat-bridge] image source check failed:", err.message);
    } finally { imageRetryRunning = false; }
  }, 10000);
  imageRetryTimer.unref();
  let mediaRetryRunning = false;
  const mediaRetryTimer = setInterval(async () => {
    if (mediaRetryRunning) return;
    mediaRetryRunning = true;
    try {
      enqueueRecoveredFiles(cfg, state, await retryHdPendingManifest(cfg, { filesOnly: true }));
      await processRecoveredFileQueue(cfg, state);
      // Keep historical pending media moving after a bridge restart. Focused
      // retries enqueue themselves; an empty target asks the worker to consume
      // the next manifest row without changing the manifest or file paths.
      triggerDistill("", "");
    } catch (err) {
      console.error("[wechat-bridge] media retry failed:", err.message);
    } finally {
      mediaRetryRunning = false;
    }
  }, Number(process.env.WECHAT_MEDIA_RETRY_INTERVAL_MS || "60000"));
  mediaRetryTimer.unref();

  let hookResolveFailures = 0;
  for (;;) {
    try {
      if (hookResolveFailures >= 3) {
        await resolveHookBaseUrl(cfg, { log: hookResolveFailures === 3 });
        hookResolveFailures = 0;
      }
      await pollOnce(cfg, state);
      hookResolveFailures = 0;
    } catch (err) {
      console.error("[wechat-bridge] poll error:", err.message);
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(err.message)) {
        hookResolveFailures += 1;
      }
    }
    await sleep(cfg.poll_interval_ms || 2000);
  }
}

if (require.main === module) main();

module.exports = {
  listOpenDatabases,
  discoverDatabasePlan,
  hookReady,
  dbDiscovery,
  pollMessageDatabases,
  pollSession,
  isOutgoingV4,
  recoveredFileKey,
  enqueueRecoveredFiles,
  processRecoveredFileQueue,
  shouldEnrichMediaEvent,
};
