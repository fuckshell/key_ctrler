/**
 * PC WeChat media resolver: Hook QueryDB + xwechat_files paths -> workspace media/inbox
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execFile, spawn } = require("node:child_process");
const http = require("node:http");
const {needsNativeMiddle, requestNativeMiddle} = require('./native-middle-source');
const { resolveTalkerPolicy, displayNameForTalker, displayNameForSender } = require("./wechat-privacy");

const WORKSPACE_WECHAT =
  process.env.WECHAT_WORKSPACE ||
  path.join(process.env.HOME || "/home/su", ".openclaw/workspace-wechat");
const MEDIA_INBOX = path.join(WORKSPACE_WECHAT, "media", "inbox");
const MANIFEST_PATH = path.join(WORKSPACE_WECHAT, "media", "manifest.jsonl");
const POSTPROCESS_JOBS_PATH = path.join(WORKSPACE_WECHAT, "state", "wechat-postprocess-jobs.json");
const MANIFEST_LOCK_DIR = path.join(path.dirname(MANIFEST_PATH), ".manifest.lock");
const DECRYPT_SCRIPT = path.join(__dirname, "scripts/decrypt-wechat-dat.py");
const V2_BACKFILL_SCRIPT = path.join(__dirname, "scripts/wechat-v2-backfill.py");
const DECOMPRESS_MSG_SCRIPT = path.join(__dirname, "scripts/decompress-wechat-msg-content.py");
const APP_MESSAGE_SCRIPT = path.join(__dirname, "scripts/decode-wechat-app-message.py");

// The bridge is often launched directly (not through systemd), so the V2 image
// key must not depend on a service EnvironmentFile being present.  Keep an
// explicitly supplied environment variable authoritative and only fill missing
// values from the local key file.
function loadImageKeyEnv() {
  const envPath = path.join(__dirname, "scripts/wechat-image-key.env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^WECHAT_IMAGE_(?:AES|XOR)_KEY$/.test(key) || process.env[key]) continue;
    process.env[key] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadImageKeyEnv();

const IMAGE_TYPE = 3;
const VIDEO_TYPE = 43;
const EMOTICON_TYPE = 47;
const FILE_TYPE = 25769803825;
const HD_MIN_BYTES = Number(process.env.WECHAT_HD_MIN_BYTES || "60000");
/** wxgf 气泡解码后典型大小带 — 不是 HD */
const WXGF_BUBBLE_MAX = Number(process.env.WECHAT_WXGF_BUBBLE_MAX || "52000");
const HOOK_CDN_STAGING_WIN = process.env.WECHAT_HOOK_CDN_STAGING || "D:\\wechat-cdn-x64dbg\\bridge-out";

function buildMediaMessageKey(talker, msgRow = {}) {
  const localId = Number(msgRow.local_id ?? msgRow.localId ?? 0);
  const createTime = Number(msgRow.create_time ?? msgRow.createTime ?? 0);
  const serverId = String(msgRow.server_id ?? msgRow.serverId ?? msgRow.msg_svr_id ?? "");
  return `${talker}|${localId}|${createTime}|${serverId}`;
}

function stampImageFileIdentity(entry) {
  const out = { ...entry };
  if (out.kind !== "image") return out;
  const now = Date.now();
  out.first_seen_at_ms = Number(out.first_seen_at_ms || now);
  if (!out.file_sha) return out;
  if (out.captured_tier === "middle" || out.promoted_middle_reconciled) {
    out.middle_sha256 = out.middle_sha256 || out.file_sha;
    out.middle_first_seen_at_ms = Number(out.middle_first_seen_at_ms || now);
  } else if (out.captured_tier === "thumbnail" || out.captured_tier === "thumb") {
    out.thumbnail_sha256 = out.thumbnail_sha256 || out.file_sha;
    out.thumbnail_first_seen_at_ms = Number(out.thumbnail_first_seen_at_ms || now);
  } else if (out.hd_pending === false) {
    out.full_sha256 = out.file_sha;
    out.full_first_seen_at_ms = Number(out.full_first_seen_at_ms || now);
    if (out.promoted_thumb_reconciled) {
      out.thumbnail_sha256 = null;
      out.thumbnail_first_seen_at_ms = null;
    }
  } else {
    out.thumbnail_sha256 = out.thumbnail_sha256 || out.file_sha;
    out.thumbnail_first_seen_at_ms = Number(out.thumbnail_first_seen_at_ms || now);
  }
  return out;
}

const MEDIA_VARIANT_FIELDS = [
  "file",
  "canonical_file",
  "path_hint",
  "file_name",
  "file_sha",
  "decode_bytes",
  "hd_pending",
  "hd_requested",
  "middle_pending",
  "target_tier",
  "source_dat",
  "captured_tier",
  "middle_expected_bytes",
  "expected_full_bytes",
  "promoted_middle_reconciled",
  "promoted_thumb_reconciled",
  "middle_sha256",
  "middle_first_seen_at_ms",
  "full_sha256",
  "full_first_seen_at_ms",
];

const MEDIA_EVIDENCE_FIELDS = [
  "thumbnail_sha256",
  "thumbnail_first_seen_at_ms",
  "middle_sha256",
  "middle_first_seen_at_ms",
  "full_sha256",
  "full_first_seen_at_ms",
];

function effectiveCapturedTier(row = {}) {
  // Match the recognition gate: a tier label cannot turn known thumbnail
  // bytes into a middle source or stop looking for a distinct native capture.
  const thumbnailSha = String(row.thumbnail_sha256 || "").toLowerCase();
  const fileSha = String(row.file_sha || "").toLowerCase();
  const middleSha = String(row.middle_sha256 || "").toLowerCase();
  const expectedMiddleBytes = Number(row.middle_expected_bytes || 0);
  const verifiedMiddle = row.captured_tier === "middle" &&
    row.cdn_ready === true && expectedMiddleBytes > 0 &&
    middleSha === fileSha && Number(row.decode_bytes || 0) >= expectedMiddleBytes;
  if (thumbnailSha && [fileSha, middleSha].some(sha => sha === thumbnailSha) && !verifiedMiddle) {
    return "thumbnail";
  }
  // Native thumbnail provenance overrides legacy metadata. A separately
  // recorded current middle SHA can supersede an older thumbnail source hint.
  const source = String(row.source_dat || row.passive_upgrade_source_path || "").toLowerCase();
  if (source.endsWith("_t.dat") && !(row.file_sha && row.middle_sha256 === row.file_sha)) return "thumbnail";
  return String(row.captured_tier || "").toLowerCase();
}

function mediaRowQuality(row = {}) {
  const tier = effectiveCapturedTier(row);
  const declaredBytes = Math.max(0, Number(row.decode_bytes || 0));
  const tinyHighestKnown =
    tier === "highest-known" && declaredBytes > 0 && declaredBytes <= WXGF_BUBBLE_MAX;
  let tierRank = 0;
  if (["full", "hd", "original"].includes(tier)) tierRank = 4;
  else if (row.hd_pending === false && !tinyHighestKnown && !["thumb", "thumbnail", "middle", "ambiguous"].includes(tier)) tierRank = 3.5;
  // Native middle is the recognition source. Legacy HD metadata must not
  // prevent a verified middle capture from replacing an old thumbnail.
  else if (tier === "middle") tierRank = 5;
  else if (tier === "ambiguous") tierRank = 2;
  else if (["thumb", "thumbnail"].includes(tier)) tierRank = 1;

  let diskBytes = 0;
  for (const p of [row.file, row.canonical_file, row.path_hint]) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      diskBytes = Math.max(diskBytes, fs.statSync(p).size);
    } catch {
      // A staging file can be replaced while manifest ownership is transferred.
    }
  }
  return [diskBytes > 0 ? 1 : 0, tierRank, Math.max(diskBytes, Number(row.decode_bytes || 0))];
}

function mediaRowIsBetter(candidate, current) {
  const a = mediaRowQuality(candidate);
  const b = mediaRowQuality(current);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function mergeManifestEntryMonotonic(prev, entry, id) {
  const merged = { ...prev, ...entry, id };
  if (mediaRowIsBetter(prev, entry)) {
    for (const key of MEDIA_VARIANT_FIELDS) {
      if (prev[key] !== undefined && prev[key] !== null && prev[key] !== "") {
        merged[key] = prev[key];
      }
    }
  }
  if (prev.file_sha && entry.file_sha && prev.file_sha !== entry.file_sha && mediaRowIsBetter(prev, entry)) {
    for (const key of new Set([...Object.keys(prev), ...Object.keys(entry)])) {
      if (/^(summary|vision_|schedule_ocr)/.test(key) || ["status", "tags", "summarized_at"].includes(key)) {
        if (Object.hasOwn(prev, key)) merged[key] = prev[key];
        else delete merged[key];
      }
    }
  }
  // SHA/timestamp evidence is provenance, not a mutable current-value field.
  // A later writer may add evidence but may not erase evidence seen earlier.
  for (const key of MEDIA_EVIDENCE_FIELDS) {
    if ((merged[key] === undefined || merged[key] === null || merged[key] === "") && prev[key]) {
      merged[key] = prev[key];
    }
  }
  // A new file or a delayed resolver snapshot cannot renew this message's
  // inference budget. Source decoding has its own separate bounded checks.
  if (prev.vision_attempts != null) {
    merged.vision_attempts = Math.max(Number(prev.vision_attempts) || 0,
      Number(entry.vision_attempts) || 0);
  }
  return merged;
}

function cdnDirectInvokeEnabled(cfg) {
  const env = process.env.WECHAT_CDN_DIRECT_INVOKE;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return cfg?.cdn_direct_invoke === true;
}

function cdnNativeTriggerEnabled(cfg) {
  const env = process.env.WECHAT_NATIVE_DOWNLOAD;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return cfg?.cdn_native_trigger !== false;
}

function cdnAutoSwitchEnabled(cfg) {
  if (cfg?.cdn_auto_switch === false || cfg?.auto_switch_session === false) return false;
  const env = process.env.WECHAT_CDN_AUTO_SWITCH;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return cfg?.cdn_auto_switch !== false || cfg?.auto_switch_session === true;
}

function hookAutoInboxWinPath(fileid) {
  const stem = fileidInboxStem(fileid);
  if (!stem) return "";
  return wslToWin(hookAutoInboxPath(fileid)) || `C:\\Users\\Public\\wechat-cdn-inbox\\${stem}.jpg`;
}

async function pollHdInboxFile(fileids, minBytes = 0, maxPolls = 45, notBeforeMs = 0) {
  const expectStem = new Set((fileids || []).map(fileidInboxStem).filter(Boolean));
  for (let i = 0; i < maxPolls; i++) {
    for (const fileid of fileids || []) {
      const base = hookAutoInboxPath(fileid);
      if (!base) continue;
      for (const p of [base, `${base}.decoded.jpg`]) {
        try {
          if (!fs.existsSync(p)) continue;
          const st = fs.statSync(p);
          if (notBeforeMs && st.mtimeMs < notBeforeMs - 2000) continue;
          let candidate = p;
          let format = p.endsWith(".decoded.jpg") ? "decoded" : "jpg";
          if (!isRasterImageFile(candidate)) {
            const magic = fs.readFileSync(candidate).slice(0, 6);
            const isWxgf = magic.slice(0, 4).toString() === "wxgf";
            const isWeixinV2 = magic.equals(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]));
            const isWeixinV1 = magic.equals(Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]));
            if (!isWxgf && !isWeixinV1 && !isWeixinV2) continue;
            const decoded = `${base}.decoded.jpg`;
            const dec = decodeViaPython(candidate, decoded);
            if (!dec?.ok || !fs.existsSync(dec.out || decoded)) continue;
            candidate = dec.out || decoded;
            if (!isRasterImageFile(candidate)) continue;
            format = isWxgf ? "wxgf" : "weixin-v2";
          }
          if (!cdnImageFileAcceptable(candidate, minBytes)) continue;
          if (expectStem.has(fileidInboxStem(fileid))) {
            return { path: candidate, fileid, format };
          }
        } catch {
          /* ignore */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function enqueuePendingHd(cfg, cdnFields, savePathWin) {
  if (!cdnFields?.fileid) return null;
  const body = {
    savePath: savePathWin || hookAutoInboxWinPath(cdnFields.fileid),
    fileid: cdnFields.fileid,
    aeskey: cdnFields.aeskey || "",
    fileType: 2,
  };
  return hookRequest(cfg, "/download/pending", body, { timeoutMs: 10000 });
}

async function autoHdDownloadPipeline(
  cfg,
  talker,
  msgRow,
  nickname,
  cdnFields,
  paths,
  imageTemp,
  imageHash = "",
) {
  if (!cdnNativeTriggerEnabled(cfg) || !cdnFields?.fileid) return null;

  // The request's ImageTemp path is only a transient placeholder on Weixin
  // 4.1.10.27 and frequently never exists. Keep the Hook capture destination
  // independent from Weixin's own cache layout. The Bridge separately follows
  // the message's exact imageHash into msg/attach, so concurrent images cannot
  // be paired by mtime or "newest file" guesses.
  const saveWin = hookAutoInboxWinPath(cdnFields.fileid);
  const minBytes = Number(cdnFields.hdlength || 0);

  let pendingRes = null;
  try {
    pendingRes = await enqueuePendingHd(cfg, cdnFields, saveWin);
    if (pendingRes?.ret === 202) {
      console.log(
        `[wechat-bridge] pending queued talker=${talker.slice(0, 20)} stem=${fileidInboxStem(cdnFields.fileid)}`,
      );
    }
  } catch (err) {
    console.log(`[wechat-bridge] pending enqueue failed: ${err.message}`);
  }

  if (cdnAutoSwitchEnabled(cfg)) {
    await switchSessionForHd(cfg, talker, nickname);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const fileids = extractImageCdnFileids(msgRow.message_content, msgRow.packed_info_data);
  if (cdnFields.fileid && !fileids.includes(cdnFields.fileid)) fileids.unshift(cdnFields.fileid);

  // The global CDN hook can write the HD file before QueryDB exposes the message.
  // The filename is now the FNV64 of the complete fileid, so accepting an already
  // present exact-stem file is safe and avoids rejecting the current image as stale.
  // Keep the foreground wait short; retryHdPendingManifest handles late arrivals.
  const foregroundPolls = Math.max(
    1,
    Number(process.env.WECHAT_HD_FOREGROUND_POLLS || "4"),
  );
  const imageTempHit = imageTemp?.wsl
    ? await pollImageTempFile(imageTemp.wsl, minBytes, foregroundPolls * 2)
    : null;
  if (imageTempHit?.path) {
    const canon = canonicalizeImageFile(imageTempHit.path);
    const bytes = statSizeSafe(canon.file || imageTempHit.path);
    console.log(
      `[wechat-bridge] auto HD ok talker=${talker.slice(0, 20)} bytes=${bytes} mode=wechat_imagetemp`,
    );
    return {
      ok: true,
      ret: 0,
      retmsg: "success; mode=wechat_imagetemp",
      bytes,
      decode_bytes: bytes,
      file: canon.file,
      canonical_file: canon.canonical_file,
      file_sha: canon.file_sha,
      pending_ret: pendingRes?.ret,
    };
  }

  const hit = await pollHdInboxFile(fileids, minBytes, foregroundPolls, 0);
  if (hit?.path) {
    const canon = canonicalizeImageFile(hit.path);
    const bytes = statSizeSafe(canon.file || hit.path);
    console.log(
      `[wechat-bridge] auto HD ok talker=${talker.slice(0, 20)} bytes=${bytes} stem=${fileidInboxStem(cdnFields.fileid)}`,
    );
    return {
      ok: true,
      ret: 0,
      retmsg: "success; mode=auto_hd_pipeline",
      bytes,
      decode_bytes: bytes,
      file: canon.file,
      canonical_file: canon.canonical_file,
      file_sha: canon.file_sha,
      pending_ret: pendingRes?.ret,
    };
  }

  // Native Weixin may ignore/replace the wrapper savePath and commit the image
  // directly to msg/attach/<talker>/<month>/Img/<imageHash>.dat. That path is
  // message-exact and is therefore the safe fallback after a user opens an
  // image (or whenever Weixin performs the native download itself).
  const attachHit = await pollExactAttachDatPaths(
    paths,
    foregroundPolls * 2,
    imageHash,
  );
  if (attachHit?.path) {
    const base = `pc_${talkerHash(talker)}_${msgRow.local_id || 0}_${String(imageHash).slice(0, 8)}`;
    const dstWsl = path.join(MEDIA_INBOX, `${base}_attach.jpg`);
    const decoded = await decodeAttachDatFile(cfg, attachHit.path, dstWsl);
    if (decoded.ok) {
      const canon = canonicalizeImageFile(decoded.out);
      console.log(
        `[wechat-bridge] exact attach capture talker=${talker.slice(0, 20)} ` +
          `hash=${String(imageHash).slice(0, 8)} bytes=${decoded.bytes}`,
      );
      return {
        ok: true,
        ret: 0,
        retmsg: "success; mode=exact_attach",
        method: decoded.method,
        bytes: decoded.bytes,
        decode_bytes: decoded.bytes,
        file: canon.file,
        canonical_file: canon.canonical_file,
        file_sha: canon.file_sha,
        pending_ret: pendingRes?.ret,
      };
    }
  }

  console.log(
    `[wechat-bridge] auto HD miss talker=${talker.slice(0, 20)} stem=${fileidInboxStem(cdnFields.fileid)} (need chat focused or VM)`,
  );
  return {
    ok: false,
    ret: pendingRes?.ret ?? 202,
    retmsg: "pending_queued; hd_not_downloaded",
    pending_ret: pendingRes?.ret,
  };
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function winToWsl(p) {
  const m = String(p || "").match(/^([A-Za-z]):\\(.*)$/);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function wslToWin(p) {
  const m = String(p || "").match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  // WSL-native path (/home/...) — Hook runs in Windows Weixin.exe; must not pass Linux paths.
  return "";
}

/** Windows path for Hook POST /download (always under D: staging). */
function hookCdnSavePath(dstWsl) {
  const direct = wslToWin(dstWsl);
  if (direct && /^[A-Za-z]:\\/.test(direct)) return direct;
  const stagingWsl = winToWsl(HOOK_CDN_STAGING_WIN);
  if (stagingWsl) fs.mkdirSync(stagingWsl, { recursive: true });
  const base = path.basename(String(dstWsl || "out.jpg")).replace(/[^\w.-]/g, "_").slice(0, 64);
  const stem = base || "out.jpg";
  return `${HOOK_CDN_STAGING_WIN}\\${stem}`;
}

function copyHookDownloadToWsl(winPath, dstWsl) {
  const srcWsl = winToWsl(winPath);
  if (!srcWsl || !fs.existsSync(srcWsl)) return false;
  fs.mkdirSync(path.dirname(dstWsl), { recursive: true });
  fs.copyFileSync(srcWsl, dstWsl);
  return true;
}

function hookRequest(cfg, apiPath, body, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 0);
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, cfg.hook_base_url);
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: "POST",
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
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          if (!raw) {
            resolve({ ret: -2, retmsg: "empty_hook_response" });
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`invalid_hook_json: ${raw.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("error", (err) => {
      const db = body?.optDbName ? ` db=${body.optDbName}` : "";
      reject(new Error(`POST ${apiPath}${db}: ${err.message}`));
    });
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`hook timeout ${timeoutMs}ms ${apiPath}`));
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

async function executeSql(cfg, dbName, sql) {
  const json = await hookRequest(cfg, "/QueryDB/execute", {
    optDbName: dbName,
    SQL: sql,
  });
  if (!json || json.status !== 0 || !Array.isArray(json.data)) {
    throw new Error(json?.desc || `${dbName} query failed`);
  }
  return json.data;
}

function talkerHash(talker) {
  return crypto.createHash("md5").update(talker, "utf8").digest("hex");
}

function extractImageHash(...blobs) {
  for (const blob of blobs) {
    if (!blob) continue;
    let text = String(blob);
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && text.length >= 40) {
      const zxml = decompressMsgContentHex(text);
      if (zxml) {
        text = zxml;
      } else {
        try {
          text = Buffer.from(text, "hex").toString("utf8");
        } catch {
          continue;
        }
      }
    }
    const origin = extractXmlAttr(text, "originsourcemd5") || extractXmlAttr(text, "md5");
    if (origin && /^[0-9a-f]{32}$/i.test(origin)) return origin.toLowerCase();
    const m = text.match(/[0-9a-f]{32}/i);
    if (m) return m[0].toLowerCase();
  }
  return "";
}

function extractXmlAttr(xml, attr) {
  if (!xml) return "";
  // Match a whole XML attribute: length/aeskey must not read the preceding
  // cdnthumblength/cdnthumbaeskey and bind another tier's metadata.
  const m = String(xml).match(new RegExp(`(?:^|\\s)${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m ? m[1] : "";
}

function decompressMsgContentHex(hex) {
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length < 8) return null;
  if (hex.slice(0, 8).toLowerCase() !== "28b52ffd") return null;
  try {
    const out = execFileSync("python3", [DECOMPRESS_MSG_SCRIPT, hex], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out && (out.includes("<msg") || out.includes("<sysmsg") || out.includes("aeskey")) ? out : null;
  } catch {
    return null;
  }
}

function extractImageCdnFields(...blobs) {
  for (const blob of blobs) {
    if (!blob) continue;
    let text = String(blob);
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && text.length > 80) {
      const zxml = decompressMsgContentHex(text);
      if (zxml) {
        text = zxml;
      } else {
        try {
          const decoded = Buffer.from(text, "hex").toString("utf8");
          if (decoded.includes("<msg") || decoded.includes("imgmsg")) text = decoded;
        } catch {
          // ignore
        }
      }
    }
    if (!text.includes("<") && !text.includes("cdn")) continue;
    const fileid =
      extractXmlAttr(text, "cdnmidimgurl");
    const aeskey = extractXmlAttr(text, "aeskey");
    if (fileid && aeskey) {
      const hdFromLength = Number(extractXmlAttr(text, "length") || 0);
      const hdFromAttr = Number(extractXmlAttr(text, "hdlength") || 0);
      return {
        fileid,
        aeskey,
        target_tier: "middle",
        hdlength: Math.max(hdFromAttr, hdFromLength),
        cdnthumblength: Number(extractXmlAttr(text, "cdnthumblength") || 0),
        md5: extractXmlAttr(text, "md5") || "",
        length: hdFromLength,
      };
    }
  }
  return null;
}

/**
 * Decide which native image tier the captured plaintext actually represents.
 * Resource sizes describe encrypted/native containers, while actualBytes is
 * normally the re-encoded JPEG size. They must never be compared as if they
 * were the same quantity; source suffix and decoded dimensions carry tier
 * identity, and an unproven result remains pending.
 */
function classifyCapturedImageTier(cdnFields, actualBytes, evidence = {}) {
  const got = Math.max(0, Number(actualBytes || 0));
  const middle = Math.max(0, Number(cdnFields?.length || 0));
  const hd = Math.max(0, Number(cdnFields?.hdlength || 0));
  const sourceName = path.basename(String(evidence.sourcePath || evidence.usedDat || "")).toLowerCase();
  const imagePath = String(evidence.imagePath || evidence.file || "");
  const dims = evidence.dimensions || (imagePath ? readRasterDimensions(imagePath) : null);
  const shortSide = dims ? Math.min(Number(dims.width || 0), Number(dims.height || 0)) : 0;
  const pixels = dims ? Number(dims.width || 0) * Number(dims.height || 0) : 0;

  // The native suffix identifies a tier; a small middle image is still
  // middle. Raster dimensions and encrypted container byte counts do not.
  if (sourceName.endsWith("_t.dat") || evidence.sourceKind === "bubble") {
    return { tier: "thumbnail", actual: got, expectedMiddle: middle, expectedHd: hd, distinctHd: hd > 0 };
  }
  if (sourceName.endsWith("_h.dat") || evidence.sourceKind === "verified-hd") {
    return { tier: "hd", actual: got, expectedMiddle: middle, expectedHd: hd, distinctHd: hd > 0 };
  }
  if (sourceName.endsWith(".dat") || evidence.sourceKind === "verified-middle") {
    return { tier: "middle", actual: got, expectedMiddle: middle, expectedHd: hd, distinctHd: hd > 0 };
  }
  if (shortSide > 0 && shortSide < 500 && pixels < 300000) {
    return { tier: "thumbnail", actual: got, expectedMiddle: middle, expectedHd: hd, distinctHd: hd > 0 };
  }
  const split = middle > 0 && hd > middle + Math.max(64 * 1024, Math.floor(middle * 0.08));
  if (!split) {
    // Some incoming image XML only exposes the thumbnail `length` and omits a
    // distinct `hdlength`.  Never let that make a tiny bubble image become
    // "highest-known": doing so clears hd_pending and permanently stops the
    // exact-message HD retry before Weixin has produced the real image.
    if (got > 0 && got <= WXGF_BUBBLE_MAX) {
      return {
        tier: "thumbnail",
        actual: got,
        expectedMiddle: middle,
        expectedHd: 0,
        distinctHd: false,
      };
    }
    return { tier: "highest-known", actual: got, expectedMiddle: middle, expectedHd: hd, distinctHd: false };
  }
  // Without source provenance, byte counts alone cannot distinguish decoded
  // JPEG tiers from encrypted resource sizes. Keep the result pending.
  return { tier: "ambiguous", actual: got, expectedMiddle: middle, expectedHd: hd, distinctHd: true };
}

function extractImageCdnFileids(...blobs) {
  const out = [];
  for (const blob of blobs) {
    if (!blob) continue;
    let text = String(blob);
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && text.length > 80) {
      const zxml = decompressMsgContentHex(text);
      if (zxml) text = zxml;
      else {
        try {
          const decoded = Buffer.from(text, "hex").toString("utf8");
          if (decoded.includes("<msg") || decoded.includes("imgmsg")) text = decoded;
        } catch {
          /* ignore */
        }
      }
    }
    for (const attr of ["cdnmidimgurl"]) {
      const fid = extractXmlAttr(text, attr);
      if (fid && !out.includes(fid)) out.push(fid);
    }
  }
  return out;
}

function cdnInboxPath(talker, localId, fileid) {
  fs.mkdirSync(MEDIA_INBOX, { recursive: true });
  const fid = String(fileid || "img").slice(0, 16);
  const base = `pc_${talkerHash(talker)}_${localId || 0}_${fid}`;
  return path.join(MEDIA_INBOX, `${base}_cdn.jpg`);
}

function fileidInboxStem(fileid) {
  const s = String(fileid || "");
  if (!s) return "";
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function hookAutoInboxPath(fileid) {
  const stem = fileidInboxStem(fileid);
  if (!stem) return "";
  return path.join("/mnt/c/Users/Public/wechat-cdn-inbox", `${stem}.jpg`);
}

function buildCdnSessionKey(talker, createTime, localId) {
  const t = String(talker || "").trim();
  const ct = Number(createTime || 0);
  const lid = Number(localId || 0);
  if (!t || !ct || !lid) return "";
  return `${t}_${ct}_${lid}_1`;
}

function resolveImageCacheTempPath(accountDir, talker, localId, createTime, suffix = "mid_temp_convert") {
  if (!accountDir || !talker || !localId || !createTime) return null;
  const th = talkerHash(talker);
  const month = monthDirFromTs(Number(createTime));
  const stem = `${localId}_${createTime}_${suffix}`;
  const wsl = path.join(accountDir, "cache", month, "Message", th, "ImageTemp", stem);
  return { wsl, win: wslToWin(wsl), stem, dir: path.dirname(wsl) };
}

async function backfillWeixinV2Cache(
  cfg,
  accountDir,
  talker,
  msgRow,
  imageHash,
  sourceImage,
  { force = false, messageMd5 = "", sourceTier = "full", writeHd = true } = {},
) {
  if (!accountDir || !talker || !imageHash || !sourceImage || !isRasterImageFile(sourceImage)) {
    return null;
  }
  const month = monthDirFromTs(msgRow.create_time);
  const talkerDir = talkerHash(talker);
  const imgDir = path.join(accountDir, "msg", "attach", talkerDir, month, "Img");
  const bubbleDir = path.join(accountDir, "cache", month, "Message", talkerDir, "Bubble");
  const targets = {
    thumb: path.join(imgDir, `${imageHash}_t.dat`),
    middle: path.join(imgDir, `${imageHash}.dat`),
    hd: path.join(imgDir, `${imageHash}_h.dat`),
    bubble: path.join(bubbleDir, `${imageHash}_b.dat`),
  };

  let result;
  try {
    const scriptArgs = [
      V2_BACKFILL_SCRIPT,
      "--source", sourceImage,
      "--thumb", targets.thumb,
      "--bubble", targets.bubble,
      "--middle", targets.middle,
      "--hd", targets.hd,
      "--source-tier", sourceTier,
      "--json",
    ];
    if (!writeHd) scriptArgs.push("--skip-hd");
    if (force) scriptArgs.push("--force");
    const stdout = execFileSync(
      "python3",
      scriptArgs,
      { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    result = JSON.parse(stdout.trim());
  } catch (err) {
    console.log(`[wechat-bridge] V2 backfill failed hash=${imageHash.slice(0, 8)}: ${String(err.stderr || err.message).slice(0, 240)}`);
    return null;
  }
  if (!result?.ok) return null;

  const localId = Number(msgRow.local_id || 0);
  const createTime = Number(msgRow.create_time || 0);
  const serverId = String(msgRow.server_id || "0").replace(/[^0-9-]/g, "") || "0";
  const where =
    `message_local_id=${localId} AND message_create_time=${createTime} ` +
    `AND message_svr_id=${serverId}`;
  const thumbSize = Number(result.thumb?.container_bytes || 0);
  const middleSize = Number(result.middle?.container_bytes || 0);
  const hdSize = Number(result.hd?.container_bytes || 0);
  const resourceStatements = [
    `UPDATE MessageResourceDetail SET size=${thumbSize},status=1 WHERE type=262145 AND message_id IN (SELECT message_id FROM MessageResourceInfo WHERE ${where})`,
    `UPDATE MessageResourceDetail SET size=${middleSize},status=1 WHERE type=131073 AND message_id IN (SELECT message_id FROM MessageResourceInfo WHERE ${where})`,
  ];
  if (writeHd) {
    resourceStatements.push(
      `UPDATE MessageResourceDetail SET size=${hdSize},status=1 WHERE type=65537 AND message_id IN (SELECT message_id FROM MessageResourceInfo WHERE ${where})`,
      `INSERT INTO MessageResourceDetail(message_id,type,size,create_time,access_time,status,data_index,packed_info) ` +
        `SELECT message_id,65537,${hdSize},message_create_time,0,1,'0',NULL FROM MessageResourceInfo i ` +
        `WHERE ${where} AND NOT EXISTS (SELECT 1 FROM MessageResourceDetail d WHERE d.message_id=i.message_id AND d.type=65537)`,
    );
  }
  const executeWithRetry = async (optDbName, SQL) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const dbRes = await hookRequest(cfg, "/QueryDB/execute", { optDbName, SQL });
        if (Number(dbRes?.status || 0) !== 0) {
          throw new Error(dbRes?.desc || `${optDbName} update failed`);
        }
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  try {
    for (const SQL of resourceStatements) {
      await executeWithRetry("message_resource.db", SQL);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const middleName = `${imageHash}.dat`;
    const hdName = `${imageHash}_h.dat`;
    const messageCdn = extractImageCdnFields(msgRow.message_content, msgRow.packed_info_data);
    const middleMd5 = String(result.middle?.payload_md5 || "").toLowerCase();
    // Weixin indexes the HD row by the native md5 carried in the message XML,
    // not by a digest recalculated from our decoded/re-encoded payload.
    const hdMd5 = String(messageMd5 || messageCdn?.md5 || result.hd?.payload_md5 || "").toLowerCase();
    const middleMd5Hash = superFastHash32(middleMd5);
    const hdMd5Hash = superFastHash32(hdMd5);
    const middleExtra = hardlinkSizeExtraHex(middleSize);
    const hdExtra = hardlinkSizeExtraHex(hdSize);
    const hardlinkStatements = [
      `INSERT OR IGNORE INTO dir2id(username) VALUES(${sqlQuote(talkerDir)})`,
      `INSERT OR IGNORE INTO dir2id(username) VALUES(${sqlQuote(month)})`,
      `DELETE FROM image_hardlink_info_v4 WHERE file_name=${sqlQuote(middleName)}`,
      `INSERT INTO image_hardlink_info_v4(md5_hash,md5,type,file_name,file_size,modify_time,dir1,dir2,extra_buffer) ` +
        `SELECT ${middleMd5Hash},${sqlQuote(middleMd5)},2,${sqlQuote(middleName)},${Math.max(0, middleSize - 31)},${nowSec},a.rowid,b.rowid,X'${middleExtra}' ` +
        `FROM dir2id a,dir2id b WHERE a.username=${sqlQuote(talkerDir)} AND b.username=${sqlQuote(month)}`,
    ];
    if (writeHd) {
      hardlinkStatements.push(
        `DELETE FROM image_hardlink_info_v4 WHERE file_name=${sqlQuote(hdName)}`,
        `INSERT INTO image_hardlink_info_v4(md5_hash,md5,type,file_name,file_size,modify_time,dir1,dir2,extra_buffer) ` +
          `SELECT ${hdMd5Hash},${sqlQuote(hdMd5)},2,${sqlQuote(hdName)},${Math.max(0, hdSize - 31)},${nowSec},a.rowid,b.rowid,X'${hdExtra}' ` +
          `FROM dir2id a,dir2id b WHERE a.username=${sqlQuote(talkerDir)} AND b.username=${sqlQuote(month)}`,
      );
    }
    for (const SQL of hardlinkStatements) {
      await executeWithRetry("hardlink.db", SQL);
    }
  } catch (err) {
    console.log(`[wechat-bridge] V2 metadata sync failed hash=${imageHash.slice(0, 8)}: ${err.message}`);
  }
  console.log(
    `[wechat-bridge] V2 cache backfill ok hash=${imageHash.slice(0, 8)} tier=${sourceTier} ` +
      `thumb=${thumbSize} middle=${middleSize} hd=${writeHd ? hdSize : "skip"}`,
  );
  return { ...result, targets };
}

async function ensureExistingHdResourceMetadata(cfg, msgRow, result) {
  const sourceDat = String(result?.source_dat || "");
  if (!result?.ok || result.hd_pending !== false || !sourceDat.endsWith("_h.dat")) return false;
  const containerSize = statSizeSafe(sourceDat);
  if (containerSize <= 31) return false;
  const localId = Number(msgRow.local_id || 0);
  const createTime = Number(msgRow.create_time || 0);
  const serverId = String(msgRow.server_id || "0").replace(/[^0-9-]/g, "") || "0";
  if (!localId || !createTime) return false;
  const where =
    `message_local_id=${localId} AND message_create_time=${createTime} ` +
    `AND message_svr_id=${serverId}`;
  const statements = [
    `UPDATE MessageResourceDetail SET size=${containerSize},status=1 WHERE type=65537 ` +
      `AND message_id IN (SELECT message_id FROM MessageResourceInfo WHERE ${where})`,
    `INSERT INTO MessageResourceDetail(message_id,type,size,create_time,access_time,status,data_index,packed_info) ` +
      `SELECT message_id,65537,${containerSize},message_create_time,0,1,'0',NULL FROM MessageResourceInfo i ` +
      `WHERE ${where} AND NOT EXISTS (SELECT 1 FROM MessageResourceDetail d WHERE d.message_id=i.message_id AND d.type=65537)`,
  ];
  try {
    for (const SQL of statements) {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const dbRes = await hookRequest(cfg, "/QueryDB/execute", {
            optDbName: "message_resource.db",
            SQL,
          });
          if (Number(dbRes?.status || 0) !== 0) throw new Error(dbRes?.desc || "resource update failed");
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      if (lastError) throw lastError;
    }
    return true;
  } catch (err) {
    console.log(`[wechat-bridge] native HD resource sync failed: ${err.message}`);
    return false;
  }
}

// Chromium base::PersistentHash/SuperFastHash. Weixin uses this 32-bit value
// as the indexed companion to the lowercase MD5 string in hardlink.db.
function superFastHash32(value) {
  const data = Buffer.from(String(value || ""), "utf8");
  if (!data.length) return 0;
  let hash = data.length >>> 0;
  let offset = 0;
  const blocks = data.length >>> 2;
  for (let i = 0; i < blocks; i += 1) {
    hash = (hash + data.readUInt16LE(offset)) >>> 0;
    const tmp = (((data.readUInt16LE(offset + 2) << 11) >>> 0) ^ hash) >>> 0;
    hash = (((hash << 16) >>> 0) ^ tmp) >>> 0;
    offset += 4;
    hash = (hash + (hash >>> 11)) >>> 0;
  }
  switch (data.length & 3) {
    case 3:
      hash = (hash + data.readUInt16LE(offset)) >>> 0;
      hash ^= (hash << 16) >>> 0;
      hash ^= data[offset + 2] << 18;
      hash = (hash + (hash >>> 11)) >>> 0;
      break;
    case 2:
      hash = (hash + data.readUInt16LE(offset)) >>> 0;
      hash ^= (hash << 11) >>> 0;
      hash = (hash + (hash >>> 17)) >>> 0;
      break;
    case 1:
      hash = (hash + data[offset]) >>> 0;
      hash ^= (hash << 10) >>> 0;
      hash = (hash + (hash >>> 1)) >>> 0;
      break;
    default:
      break;
  }
  hash ^= (hash << 3) >>> 0;
  hash = (hash + (hash >>> 5)) >>> 0;
  hash ^= (hash << 4) >>> 0;
  hash = (hash + (hash >>> 17)) >>> 0;
  hash ^= (hash << 25) >>> 0;
  hash = (hash + (hash >>> 6)) >>> 0;
  return hash >>> 0;
}

function hardlinkSizeExtraHex(containerBytes) {
  let value = Math.max(0, Number(containerBytes || 0)) >>> 0;
  const bytes = [0x10];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes).toString("hex");
}

function isPromotedHdThumbResult(result) {
  if (!result?.ok || !String(result.source_dat || "").endsWith("_t.dat")) return false;
  const source = result.canonical_file || result.file || "";
  if (!source || !isRasterImageFile(source)) return false;
  const dims = readRasterDimensions(source);
  if (!dims) return false;
  return Math.min(dims.width, dims.height) >= 720 || dims.width * dims.height >= 600000;
}

async function reconcilePromotedHdThumb(cfg, accountDir, talker, msgRow, result) {
  if (!accountDir || !talker || !result?.image_hash || !isPromotedHdThumbResult(result)) {
    return result;
  }
  const source = result.canonical_file || result.file;
  const sourceBytes = Number(result.decode_bytes || statSizeSafe(source) || 0);
  const cdnFields = extractImageCdnFields(msgRow.message_content, msgRow.packed_info_data);
  const tier = classifyCapturedImageTier(cdnFields, sourceBytes);
  const trueHd = tier.tier === "hd" || tier.tier === "highest-known";
  const repaired = await backfillWeixinV2Cache(
    cfg,
    accountDir,
    talker,
    msgRow,
    result.image_hash,
    source,
    {
      force: true,
      sourceTier: trueHd ? "full" : "middle",
      writeHd: trueHd,
    },
  );
  if (!repaired?.ok) return result;
  console.log(
    `[wechat-bridge] promoted capture reconciled hash=${String(result.image_hash).slice(0, 8)} ` +
      `tier=${tier.tier} got=${sourceBytes} middle=${tier.expectedMiddle || 0} hd=${tier.expectedHd || 0}`,
  );
  return {
    ...result,
    hd_pending: !trueHd,
    captured_tier: tier.tier,
    middle_expected_bytes: tier.expectedMiddle || null,
    expected_full_bytes: tier.expectedHd || sourceBytes,
    promoted_thumb_reconciled: trueHd,
    promoted_middle_reconciled: !trueHd,
    method: `${result.method || "v2-decode"}+promoted-${tier.tier}-reconciled`,
  };
}

function isPlainImageFile(p) {
  if (!p || !fs.existsSync(p)) return false;
  try {
    const head = fs.readFileSync(p).slice(0, 4);
    return head[0] === 0xff && head[1] === 0xd8 || head.toString() === "\x89PNG";
  } catch {
    return false;
  }
}

async function pollImageTempFile(tempWsl, minBytes = 0, maxPolls = 90) {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!fs.existsSync(tempWsl)) continue;
    const size = statSizeSafe(tempWsl);
    if (size <= 0) continue;
    if (isPlainImageFile(tempWsl) && cdnBytesAcceptable(size, minBytes)) {
      return { path: tempWsl, bytes: size, format: "jpeg" };
    }
    const head = fs.readFileSync(tempWsl).slice(0, 4).toString();
    if (head === "wxgf" && size > 10000) {
      const decoded = `${tempWsl}.decoded.jpg`;
      const dec = decodeViaPython(tempWsl, decoded);
      if (dec?.ok && fs.existsSync(decoded) && cdnBytesAcceptable(statSizeSafe(decoded), minBytes)) {
        return { path: decoded, bytes: statSizeSafe(decoded), format: "wxgf" };
      }
    }
  }
  return null;
}

async function downloadViaImageTemp(cfg, params, tempWsl, minBytes, meta) {
  fs.mkdirSync(path.dirname(tempWsl), { recursive: true });
  if (cdnDirectInvokeEnabled(cfg)) {
    await registerCdnPending(cfg, params, tempWsl, meta);
    await hookRequest(
      cfg,
      "/download",
      {
        savePath: wslToWin(tempWsl),
        aeskey: params.aeskey,
        fileid: params.fileid,
        chatType: Number(params.chatType ?? 0),
        largesVideo: Number(params.largesVideo ?? 0),
        fileType: Number(params.fileType ?? 2),
        sessionKey: buildCdnSessionKey(meta.talker, meta.createTime, meta.localId),
        talker: meta.talker,
        create_time: Number(meta.createTime || 0),
        local_id: Number(meta.localId || 0),
      },
      { timeoutMs: 8000 },
    );
  }
  const hit = await pollImageTempFile(tempWsl, minBytes, 90);
  if (!hit) return null;
  const dstWsl = path.join(MEDIA_INBOX, path.basename(tempWsl) + "_imagetemp.jpg");
  try {
    fs.copyFileSync(hit.path, dstWsl);
  } catch {
    return null;
  }
  const canon = canonicalizeImageFile(dstWsl);
  return {
    ret: 0,
    ok: true,
    bytes: hit.bytes,
    decode_bytes: hit.bytes,
    file: canon.file,
    canonical_file: canon.canonical_file,
    file_sha: canon.file_sha,
    retmsg: "success; mode=imagetemp_polled",
    method: hit.format === "wxgf" ? "imagetemp-wxgf" : "imagetemp-jpeg",
  };
}

async function registerCdnPending(cfg, params, dstWsl, meta = {}) {
  if (cfg?.cdn_pending_registration === false) {
    return { ret: 0, retmsg: "cdn_pending_registration_disabled" };
  }
  // Windows Hook cannot write /home/su. Use the exact-fileid inbox already
  // watched by recovery, rather than sending an empty Windows savePath.
  const captureWsl = wslToWin(dstWsl) ? dstWsl : hookAutoInboxPath(params.fileid);
  if (!captureWsl) return { ret: -2, retmsg: "missing exact image capture path" };
  fs.mkdirSync(path.dirname(captureWsl), { recursive: true });
  const body = {
    savePath: wslToWin(captureWsl),
    aeskey: params.aeskey,
    fileid: params.fileid,
    chatType: Number(params.chatType ?? 0),
    largesVideo: Number(params.largesVideo ?? 0),
    fileType: Number(params.fileType ?? 2),
  };
  const sessionKey =
    params.sessionKey ||
    params.session_key ||
    buildCdnSessionKey(meta.talker, meta.createTime ?? meta.create_time, meta.localId ?? meta.local_id);
  if (sessionKey) body.sessionKey = sessionKey;
  if (meta.talker) body.talker = meta.talker;
  if (meta.createTime ?? meta.create_time) body.create_time = Number(meta.createTime ?? meta.create_time);
  if (meta.localId ?? meta.local_id) body.local_id = Number(meta.localId ?? meta.local_id);
  try {
    return await hookRequest(cfg, "/download/pending", body, { timeoutMs: 2500 });
  } catch (err) {
    return { ret: -1, retmsg: err.message };
  }
}

async function preRegisterImageCdnPending(cfg, talker, msgRow) {
  // Compatibility entry point only. A pending registration redirects native
  // downloads; it neither creates a middle request nor proves source readiness.
  // The current media policy leaves download ownership with WeChat and reads
  // exact native caches in materializeImage/retryImageSources instead.
  return { ret: 0, retmsg: "native_middle_cache_only" };
}

function shouldAutoDownloadCdn(cfg, talker) {
  const list = cfg.cdn_auto_download_talkers;
  if (Array.isArray(list) && list.length > 0) return list.includes(talker);
  // This gate controls registration of the native middle image source only.
  // Never reuse auto_reply_whitelist here: reply routing and media capture have
  // different policies. With no explicit CDN talker list, register every image
  // so image-tier-not-ready can recover from a real middle source. The caller
  // still keeps cdn_native_trigger=false, so this does not enable HD downloads.
  const wl = cfg.cdn_auto_download_whitelist;
  if (cfg.cdn_auto_download_use_whitelist && Array.isArray(wl) && wl.length > 0) {
    return wl.includes(talker);
  }
  return true;
}

async function triggerImageCdnDownload(cfg, talker, msgRow, nickname = "") {
  // Do not let legacy CDN/HD flags opt image ingestion back into path takeover,
  // session switching or direct invocation. Source acquisition stays passive.
  return null;
}

function cdnBytesAcceptable(bytes, hdlength) {
  const got = Number(bytes || 0);
  if (got <= 0) return false;
  // 解码后的真 HD JPEG 通常 80KB+；hdlength 是 CDN 线路上报值，不能按 0.45 去卡 JPEG
  if (got >= 80000) return true;
  // 43–51KB 气泡/wxgf 带 — 一律不是 HD
  if (got <= WXGF_BUBBLE_MAX) return false;
  const expect = Number(hdlength || 0);
  if (!expect || expect < 80000) return got >= HD_MIN_BYTES;
  return got >= Math.max(HD_MIN_BYTES, Math.floor(expect * 0.12));
}

function readRasterDimensions(p) {
  try {
    const data = fs.readFileSync(p);
    if (
      data.length >= 24 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    ) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
    let off = 2;
    while (off + 8 < data.length) {
      while (off < data.length && data[off] !== 0xff) off += 1;
      while (off < data.length && data[off] === 0xff) off += 1;
      if (off >= data.length) break;
      const marker = data[off++];
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (off + 2 > data.length) break;
      const len = data.readUInt16BE(off);
      if (len < 2 || off + len > data.length) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && len >= 7) {
        return { width: data.readUInt16BE(off + 5), height: data.readUInt16BE(off + 3) };
      }
      off += len;
    }
  } catch {
    // ignore malformed or concurrently written files
  }
  return null;
}

function cdnImageFileAcceptable(p, hdlength = 0) {
  if (!p || !fs.existsSync(p) || !isRasterImageFile(p)) return false;
  const dims = readRasterDimensions(p);
  if (dims) {
    const shortSide = Math.min(dims.width, dims.height);
    const pixels = dims.width * dims.height;
    // White-background product shots and screenshots can be visually full-size
    // while compressing far below the old 60KB threshold.
    if (shortSide >= 720 || pixels >= 600000) return true;
  }
  return cdnBytesAcceptable(statSizeSafe(p), hdlength);
}

function expectedBytesFromImage(cdnFields, expectation) {
  const fromRes = Number(expectation?.full || 0);
  const fromCdn = Number(cdnFields?.hdlength || 0);
  return Math.max(fromRes, fromCdn);
}

function shouldMarkHdPending(decodeBytes, cdnFields, expectation, { usedDat = "" } = {}) {
  const got = Number(decodeBytes || 0);
  const expect = expectedBytesFromImage(cdnFields, expectation);
  if (expect >= 50000 && got > 0 && !cdnBytesAcceptable(got, expect)) return true;
  if (expectation?.hd_pending && String(usedDat).endsWith("_t.dat") && got > 0 && got < expect) {
    return true;
  }
  // CDN 可用但只有 bubble 级小图 → 继续等 HD
  if (got > 0 && got <= WXGF_BUBBLE_MAX && cdnFields?.fileid && cdnFields?.aeskey) return true;
  return false;
}

function finalizeImageResult(result, cdnFields, expectation, extras = {}) {
  const out = { ...result };
  const expected = expectedBytesFromImage(cdnFields, expectation);
  if (expected) out.expected_full_bytes = expected;
  if (cdnFields?.hdlength) out.hdlength = Number(cdnFields.hdlength);
  if (cdnFields?.length) out.middle_expected_bytes = Number(cdnFields.length);
  if (cdnFields?.fileid) {
    out.cdn_fileid = out.cdn_fileid || cdnFields.fileid;
    out.cdn_aeskey = out.cdn_aeskey || cdnFields.aeskey;
    out.cdn_ready = true;
  }
  if (out.ok && out.decode_bytes != null) {
    const qualityPath = out.canonical_file || out.file || "";
    const capturedTier = classifyCapturedImageTier(cdnFields, out.decode_bytes, {
      imagePath: qualityPath,
      sourcePath: extras.usedDat || out.source_dat || "",
    });
    out.captured_tier = capturedTier.tier;
    const usedName = path.basename(String(extras.usedDat || ""));
    // Weixin 4.x attach tiers: *_t.dat=thumbnail, <hash>.dat=middle,
    // *_h.dat=full. A middle image can retain 1080px dimensions while being
    // aggressively compressed, so dimensions alone must not promote it to HD.
    const sourceIsNonHdAttach =
      usedName.endsWith("_t.dat") ||
      (usedName.endsWith(".dat") && !usedName.endsWith("_h.dat"));
    out.hd_pending = capturedTier.tier === "middle" || capturedTier.tier === "ambiguous"
      ? true
      : sourceIsNonHdAttach
      ? true
      : qualityPath && cdnImageFileAcceptable(qualityPath, expected)
        ? false
        : shouldMarkHdPending(out.decode_bytes, cdnFields, expectation, extras);
  } else if (!out.ok && expected && cdnFields?.fileid) {
    out.hd_pending = true;
  }
  return out;
}

function findExistingCdnFile(fileids, minBytes = 0) {
  for (const fileid of fileids || []) {
    for (const p of [hookAutoInboxPath(fileid), `${hookAutoInboxPath(fileid)}.decoded.jpg`].filter(Boolean)) {
      try {
        if (!fs.existsSync(p) || fs.statSync(p).size <= 0) continue;
        if (isRasterImageFile(p)) {
          const size = fs.statSync(p).size;
          if (!cdnImageFileAcceptable(p, minBytes)) continue;
          return { path: p, fileid };
        }
        const magic = fs.readFileSync(p).slice(0, 6);
        const head = magic.slice(0, 4).toString();
        const isWeixinV2 = magic.equals(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]));
        const isWeixinV1 = magic.equals(Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]));
        if (head === "wxgf" || isWeixinV1 || isWeixinV2) {
          const out = `${p}.decoded.jpg`;
          const dec = decodeViaPython(p, out);
          if (dec?.ok && fs.existsSync(out) && isRasterImageFile(out)) {
            const size = fs.statSync(out).size;
            if (!cdnImageFileAcceptable(out, minBytes)) continue;
            return { path: out, fileid, format: head === "wxgf" ? "wxgf" : "weixin-v2" };
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function sessionSwitchQuery(cfg, talker, nickname = "") {
  const nick = String(nickname || "").trim();
  if (nick && nick !== talker && !/^wxid_[0-9a-f]+$/i.test(nick)) return nick;
  const mapped = cfg.group_display_names?.[talker];
  if (mapped && mapped !== talker) return mapped;
  const short = String(talker || "").replace(/^wxid_/, "").slice(0, 16);
  return short || talker;
}

async function switchSessionForHd(cfg, talker, nickname = "") {
  if (!cdnAutoSwitchEnabled(cfg)) return null;
  const queries = [];
  const nick = sessionSwitchQuery(cfg, talker, nickname);
  if (nick) queries.push(nick);
  if (talker && !queries.includes(talker)) queries.push(talker);
  const shortWxid = String(talker || "").replace(/^wxid_/, "").slice(0, 16);
  if (shortWxid && !queries.includes(shortWxid)) queries.push(shortWxid);

  let last = null;
  for (const query of queries) {
    try {
      const res = await hookRequest(
        cfg,
        "/SwitchSession",
        { query, wait_ms: 1500 },
        { timeoutMs: 20000 },
      );
      last = res;
      if (res?.ret === 0) {
        console.log(`[wechat-bridge] switch session ok query=${query.slice(0, 24)} method=${res.method || "?"}`);
        return res;
      }
      if (res?.ret === -501 || res?.ret === -503 || res?.ret === -504) {
        console.log(`[wechat-bridge] switch session not implemented: ${res.retmsg || "?"}`);
        return res;
      }
      console.log(`[wechat-bridge] switch session ret=${res?.ret} query=${query.slice(0, 24)} msg=${res?.retmsg || "?"}`);
    } catch (err) {
      console.log(`[wechat-bridge] switch session failed: ${err.message}`);
      last = null;
    }
  }
  return last;
}

async function downloadViaCdnDirect(cfg, params, dstWsl, minBytes = 0, meta = {}) {
  if (!cdnDirectInvokeEnabled(cfg)) {
    return { ok: false, ret: -503, retmsg: "cdn_direct_invoke_disabled" };
  }
  const hookSave = hookCdnSavePath(dstWsl);
  const body = {
    savePath: hookSave,
    aeskey: params.aeskey,
    fileid: params.fileid,
    chatType: Number(params.chatType ?? 0),
    largesVideo: Number(params.largesVideo ?? 0),
    fileType: Number(params.fileType ?? 2),
  };
  const sessionKey =
    params.sessionKey ||
    params.session_key ||
    buildCdnSessionKey(meta.talker, meta.createTime ?? meta.create_time, meta.localId ?? meta.local_id);
  if (sessionKey) body.sessionKey = sessionKey;
  if (meta.talker) body.talker = meta.talker;
  if (meta.createTime ?? meta.create_time) body.create_time = Number(meta.createTime ?? meta.create_time);
  if (meta.localId ?? meta.local_id) body.local_id = Number(meta.localId ?? meta.local_id);

  fs.mkdirSync(path.dirname(dstWsl), { recursive: true });
  const res = await hookRequest(cfg, "/download", body, { timeoutMs: 90000 });
  const bytes = Number(res?.bytes || 0);
  if (res?.ret === 0 && bytes > 0) {
    if (hookSave !== wslToWin(dstWsl)) copyHookDownloadToWsl(hookSave, dstWsl);
    let outPath = dstWsl;
    if (isPlainImageFile(dstWsl)) {
      /* use as-is */
    } else if (fs.existsSync(dstWsl) && fs.readFileSync(dstWsl).slice(0, 4).toString() === "wxgf") {
      const decoded = `${dstWsl}.decoded.jpg`;
      const dec = decodeViaPython(dstWsl, decoded);
      if (dec?.ok && fs.existsSync(decoded)) outPath = decoded;
    }
    if (isPlainImageFile(outPath) || (fs.existsSync(outPath) && statSizeSafe(outPath) > 0)) {
      const canon = canonicalizeImageFile(outPath);
      const got = statSizeSafe(canon.file || outPath);
      if (cdnImageFileAcceptable(canon.file || outPath, minBytes)) {
        return {
          ...res,
          ok: true,
          bytes: got,
          decode_bytes: got,
          file: canon.file,
          canonical_file: canon.canonical_file,
          file_sha: canon.file_sha,
        };
      }
    }
  }
  return { ...res, ok: false };
}

async function downloadViaCdn(cfg, params, dstWsl, minBytes = 0, meta = {}) {
  return downloadViaCdnDirect(cfg, params, dstWsl, minBytes, meta);
}

async function uploadViaCdn(cfg, params) {
  return hookRequest(cfg, "/upload", {
    fileType: Number(params.fileType ?? 2),
    aeskey: params.aeskey,
    filePath: wslToWin(params.filePath),
    userName: params.userName || params.wxid || "",
    chatType: Number(params.chatType ?? 0),
  });
}

function extractUtf8Strings(hexOrText) {
  if (!hexOrText) return [];
  let raw = String(hexOrText);
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    try {
      raw = Buffer.from(raw, "hex").toString("utf8");
    } catch {
      return [];
    }
  }
  const out = [];
  // WeChat's protobuf fields may contain short but valid names such as
  // "4班.xlsx". Requiring four characters before the extension silently
  // discarded them and left the manifest with no usable filename.
  for (const m of raw.matchAll(/[\u4e00-\u9fffA-Za-z0-9_\-().（）【】\s]{1,120}\.(pdf|docx|doc|xlsx|xls|pptx|zip|rar|txt|md|csv)/gi)) {
    out.push(m[0].trim());
  }
  return out;
}

const attachmentMetadataCache = new Map();
function attachmentMetadata(raw) {
  if (!raw) return {};
  const key = crypto.createHash("sha256").update(String(raw)).digest("hex");
  if (attachmentMetadataCache.has(key)) return attachmentMetadataCache.get(key);
  let metadata = {};
  try {
    const card = JSON.parse(execFileSync("python3", [APP_MESSAGE_SCRIPT], {
      input: JSON.stringify({raw}), encoding: "utf8", timeout: 8000,
      maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
    if (card.ok && card.subtype === 6) metadata = card.attachment || {};
  } catch { /* Resource protobufs are not app XML; retain their exact-name parser. */ }
  if (attachmentMetadataCache.size >= 256) attachmentMetadataCache.delete(attachmentMetadataCache.keys().next().value);
  attachmentMetadataCache.set(key, metadata);
  return metadata;
}

function diskMessageDatabases(cfg) {
  const root = cfg?.wechat_files_root || process.env.WECHAT_FILES_ROOT || "";
  const wxid = cfg?.wechat_account_wxid || cfg?.self_wxid || cfg?.pc_login_wxid || "";
  if (!root || !wxid) return [];
  try {
    const accounts = fs.readdirSync(root).filter(name => name === wxid || name.startsWith(`${wxid}_`));
    const found = new Set();
    for (const account of accounts) {
      const dir = path.join(root, account, "db_storage", "message");
      for (const entry of fs.readdirSync(dir)) if (/^message_\d+\.db$/.test(entry)) found.add(entry);
    }
    return [...found].sort((a,b) => Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  } catch { return []; }
}

async function fetchExactMessageRow(cfg, row) {
  const talker = String(row.talker || "");
  const ts = Math.floor(Number(row.message_create_time || Number(row.ts || 0) / 1000));
  if (!talker || !ts) throw new Error("message-identity-missing");
  const table = "Msg_" + crypto.createHash("md5").update(talker).digest("hex");
  let names = diskMessageDatabases(cfg);
  if (!names.length) {
    const discovered = await hookRequest(cfg, "/QueryDB/GetAllDBName", {});
    names = Array.isArray(discovered) ? discovered : discovered?.data;
    if (!Array.isArray(names)) throw new Error("message-database-discovery-unavailable");
  }
  const databases = [...new Set([...(cfg.msg_databases || []), ...names.map(r => typeof r === "string" ? r : r.dbName).filter(n => /^message_\d+\.db$/.test(n || ""))])];
  let readable = false;
  const matches = new Map();
  for (const db of databases) {
    try {
      const tables = await executeSql(cfg, db, `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlQuote(table)}`);
      readable = true;
      if (!tables.length) continue;
      const local = Number(row.local_id || 0);
      const candidates = await executeSql(cfg, db, `SELECT *, CAST(server_id AS TEXT) AS exact_server_id FROM ${table} WHERE create_time=${ts}` +
        (local > 0 ? ` AND local_id=${local}` : ""));
      for (const candidate of candidates) {
        // Historical placeholders have only talker, second and media kind.
        // Text and media sent in that same second are separate identities.
        // Kind narrows the source; it never chooses between two same-kind rows.
        const {baseType} = decodeMessageType(candidate.local_type);
        const expected = {image: [3], video: [43], emoticon: [47], file: [34, 49]}[row.kind];
        if (expected && !expected.includes(baseType)) continue;
        const server = String(row.server_id || "");
        // Older Hook JSON emitted 64-bit IDs as numbers. Accept its rounded
        // representation only with both exact local_id and create_time.
        if (server && server !== "0" && server !== candidate.exact_server_id &&
            !(local > 0 && !Number.isSafeInteger(Number(server)) && Number(server) === Number(candidate.exact_server_id))) continue;
        const exact = {...candidate, server_id:candidate.exact_server_id, message_db:db};
        const identity = `${exact.local_id}|${exact.server_id}|${exact.create_time}`;
        const previous = matches.get(identity);
        if (previous && ["local_type", "message_content", "compress_content", "packed_info_data", "real_sender_id"]
            .some(field => String(previous[field] ?? "") !== String(exact[field] ?? ""))) {
          throw new Error("message-source-conflict");
        }
        matches.set(identity, exact);
      }
    } catch (error) {
      if (!/get database handle|no such table/i.test(error.message)) throw error;
    }
  }
  if (!readable) throw new Error("message-database-unavailable");
  if (matches.size !== 1) throw new Error(matches.size ? "message-identity-ambiguous" : "message-not-found");
  return [...matches.values()][0];
}

function extractAttachmentFileNames(...values) {
  const names = new Set();
  for (const value of values) {
    const metadata = attachmentMetadata(value);
    if (metadata.file_name) names.add(metadata.file_name);
    for (const rawName of extractUtf8Strings(value)) {
      const normalized = rawName.replace(/[\x00-\x1f]+/g, "").trim();
      if (normalized) names.add(normalized);
      // Protobuf framing bytes can decode as a numeric prefix, e.g.
      // "2\\n0初三课表.xlsx". Preserve the filename suffix beginning at the
      // first CJK character so cache lookup remains message-specific.
      const cjkStart = normalized.search(/[\u4e00-\u9fff]/);
      if (cjkStart > 0) names.add(normalized.slice(cjkStart));
    }
  }
  return [...names];
}

function isMediaPayload(content, localType) {
  const { baseType } = decodeMessageType(localType);
  const t = Number(localType);
  if ([IMAGE_TYPE, VIDEO_TYPE, EMOTICON_TYPE, 49].includes(baseType)) return true;
  // 10000 is a system notice, not an attachment. Ordinary V4 text (type=1)
  // is frequently a long zstd hex frame and must never be classified by its
  // encoded appearance.
  if (t === 1 || t === 10000) return false;
  const c = String(content || "").trim();
  if (/^\[(图片|照片|文件|视频|语音)\]$/.test(c)) return true;
  if ((!Number.isFinite(t) || t === 0) && /^[0-9A-Fa-f]{120,}$/.test(c)) return true;
  return false;
}

function mediaPlaceholder(localType) {
  const { baseType: t } = decodeMessageType(localType);
  if (t === IMAGE_TYPE) return "[图片]";
  if (t === VIDEO_TYPE) return "[视频]";
  if (t === EMOTICON_TYPE) return "[动画表情]";
  if (mediaKind(localType) === "app_card") return "[应用消息]";
  return "[文件]";
}

function mediaKind(localType) {
  const { baseType: t, subtype } = decodeMessageType(localType);
  if (t === IMAGE_TYPE) return "image";
  if (t === VIDEO_TYPE) return "video";
  if (t === EMOTICON_TYPE) return "emoticon";
  if (t === 49 && subtype !== 6) return "app_card";
  return "file";
}

function decodeMessageType(localType) {
  try {
    if (typeof localType === "number" && !Number.isSafeInteger(localType)) throw new Error("unsafe-type");
    const type = BigInt(localType ?? 0);
    if (type < 0n) throw new Error("negative-type");
    return { baseType: Number(type & 0xffffffffn), subtype: Number(type >> 32n) };
  } catch {
    return { baseType: 0, subtype: 0 };
  }
}

function enrichAppCardEvent(cfg, event, msgRow) {
  const raw = msgRow.message_content || msgRow.decoded_message_content || event.content || "";
  let card;
  try {
    card = JSON.parse(execFileSync("python3", [APP_MESSAGE_SCRIPT], {
      input: JSON.stringify({ raw }), encoding: "utf8", timeout: 8000,
      maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    card = { ok: false, error: "app-message-parser-failed" };
  }
  const declaredSubtype = decodeMessageType(msgRow.local_type).subtype;
  const subtypeMismatch = card.ok && declaredSubtype > 0 && declaredSubtype !== card.subtype;
  const error = card.error || (subtypeMismatch ? "app-message-subtype-mismatch" :
    (!card.text ? "app-message-business-text-missing" : null));
  // WeChat stores animated stickers as appmsg type=8 (base message type 49),
  // with no business text and an emoticon attachment digest.  Treating this
  // as an unreadable app card sends a non-business reaction through the media
  // retry budget.  Preserve the exact source evidence while making the
  // deterministic no-op explicit; this mirrors the existing type-47 emoji
  // handling and does not fetch or synthesize sticker bytes.
  if (card.ok && card.subtype === 8 && !subtypeMismatch) {
    const key = buildMediaMessageKey(event.talker, msgRow);
    event.media_kind = "emoticon";
    event.media_status = "ready";
    event.media_error = null;
    event.media_app_subtype = card.subtype;
    event.media_declared_subtype = declaredSubtype;
    event.content = "[动画表情]";
    event.media_message_key = key;
    event.media_local_id = Number(msgRow.local_id);
    event.media_server_id = String(msgRow.server_id ?? "");
    event.media_create_time = Number(msgRow.create_time);
    appendManifest({
      id: key, message_key: key, talker: event.talker, local_id: msgRow.local_id,
      server_id: String(msgRow.server_id || ""), ts: Number(msgRow.create_time || 0) * 1000,
      kind: "emoticon", type: msgRow.local_type, status: "done",
      content: event.content, summary: event.content, original_content: raw,
      decoded_xml: card.xml || null, app_subtype: card.subtype,
      declared_subtype: declaredSubtype, media_error: null,
      media_semantics: "animated_emoji",
      repair_evidence: {kind: "verified-appmsg-type8-emoji-noop", business_result: "reaction-without-task-or-schedule-text"},
      source: "pc-hook",
    });
    return event;
  }
  if (card.ok && card.subtype === 6 && !subtypeMismatch) {
    return enrichEventMedia(cfg, event, { ...msgRow, local_type: FILE_TYPE });
  }
  event.media_kind = "app_card";
  event.media_status = card.ok && card.text && !error ? "ready" : "app_message_decode_failed";
  event.media_error = error;
  event.media_app_subtype = card.subtype ?? null;
  event.media_declared_subtype = declaredSubtype;
  event.content = card.ok && card.text
    ? `[应用消息 type=${card.subtype}]\n${card.text}`
    : "[应用消息内容未完整解析：需核实原始证据，不能视为无关消息]";
  if (subtypeMismatch) event.content += "\n[应用消息声明类型与正文类型冲突：需核实原始证据]";
  const key = buildMediaMessageKey(event.talker, msgRow);
  event.media_message_key = key;
  event.media_local_id = Number(msgRow.local_id);
  event.media_server_id = String(msgRow.server_id ?? "");
  event.media_create_time = Number(msgRow.create_time);
  appendManifest({
    id: key, message_key: key, talker: event.talker, local_id: msgRow.local_id,
    server_id: String(msgRow.server_id || ""), ts: Number(msgRow.create_time || 0) * 1000,
    kind: "app_card", type: msgRow.local_type, status: event.media_status === "ready" ? "ready" : "missing",
    content: event.content, summary: event.content, original_content: raw,
    decoded_xml: card.xml || null, app_subtype: card.subtype ?? null,
    declared_subtype: declaredSubtype, media_error: error,
    source: "pc-hook",
  });
  return event;
}

async function getFilesRoot(cfg) {
  if (cfg.wechat_files_root) return cfg.wechat_files_root;
  if (process.env.WECHAT_FILES_ROOT) return process.env.WECHAT_FILES_ROOT;
  try {
    const rows = await executeSql(
      cfg,
      "hardlink.db",
      "SELECT ValueStdStr FROM db_info WHERE Key='uuid' LIMIT 1",
    );
    const uuid = rows[0]?.ValueStdStr || "";
    const m = uuid.match(/_([A-Za-z]:\\.+)$/);
    if (m) return winToWsl(m[1]);
  } catch {
    // ignore
  }
  return "";
}

function findAccountDir(root, wxid) {
  if (!root || !wxid) return "";
  try { fs.statSync(root); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  const entries = fs.readdirSync(root);
  const hit = entries.find((e) => e === wxid || e.startsWith(`${wxid}_`));
  return hit ? path.join(root, hit) : "";
}

async function lookupImageHardlink(cfg, imageHash) {
  const rows = await executeSql(
    cfg,
    "hardlink.db",
    `SELECT h.file_name, h.file_size, h.modify_time, d1.username AS dir1_name, d2.username AS dir2_name ` +
      `FROM image_hardlink_info_v4 h ` +
      `LEFT JOIN dir2id d1 ON h.dir1 = d1.rowid ` +
      `LEFT JOIN dir2id d2 ON h.dir2 = d2.rowid ` +
      `WHERE h.file_name LIKE ${sqlQuote(`${imageHash}%`)} ` +
      `ORDER BY h.file_size DESC, h.modify_time DESC LIMIT 8`,
  );
  const full =
    rows.find((r) => r.file_name === `${imageHash}.dat`) ||
    rows.find((r) => /^\w{32}\.dat$/.test(r.file_name || "")) ||
    rows[0];
  return full || null;
}

async function lookupImageHardlinkAll(cfg, imageHash) {
  const rows = await executeSql(
    cfg,
    "hardlink.db",
    `SELECT h.file_name, h.file_size, h.modify_time, d1.username AS dir1_name, d2.username AS dir2_name ` +
      `FROM image_hardlink_info_v4 h ` +
      `LEFT JOIN dir2id d1 ON h.dir1 = d1.rowid ` +
      `LEFT JOIN dir2id d2 ON h.dir2 = d2.rowid ` +
      `WHERE h.file_name LIKE ${sqlQuote(`${imageHash}%`)} ` +
      `ORDER BY h.file_size DESC, h.modify_time DESC LIMIT 12`,
  );
  return rows.sort(
    (a, b) =>
      Number(b.file_size || 0) - Number(a.file_size || 0) ||
      imageDatSuffixRank(a.file_name || "", imageHash) -
        imageDatSuffixRank(b.file_name || "", imageHash),
  );
}

function imageResourceExpectation(resources) {
  let thumb = 0;
  let full = 0;
  for (const row of resources || []) {
    const size = Number(row.res_size || row.size || 0);
    const type = Number(row.res_type || row.type || 0);
    if (!size) continue;
    if (type === 262145) thumb = Math.max(thumb, size);
    if (type === 131073) full = Math.max(full, size);
  }
  return { thumb, full, hd_pending: full > thumb && full > 0 };
}

async function lookupFileHardlink(cfg, fileName) {
  const rows = await executeSql(
    cfg,
    "hardlink.db",
    `SELECT h.file_name, h.file_size, h.modify_time, d1.username AS dir1_name, d2.username AS dir2_name ` +
      `FROM file_hardlink_info_v4 h ` +
      `LEFT JOIN dir2id d1 ON h.dir1 = d1.rowid ` +
      `LEFT JOIN dir2id d2 ON h.dir2 = d2.rowid ` +
      `WHERE h.file_name = ${sqlQuote(fileName)} ` +
      `ORDER BY h.modify_time DESC LIMIT 3`,
  );
  return rows[0] || null;
}

async function fetchMessageResources(cfg, talker, localId) {
  return executeSql(
    cfg,
    "message_resource.db",
    `SELECT i.message_id, i.message_local_type, i.message_create_time, i.packed_info, ` +
      `d.type AS res_type, d.size AS res_size, d.packed_info AS detail_info ` +
      `FROM MessageResourceInfo i ` +
      `JOIN ChatName2Id c ON i.chat_id = c.rowid ` +
      `LEFT JOIN MessageResourceDetail d ON d.message_id = i.message_id ` +
      `WHERE c.user_name = ${sqlQuote(talker)} AND i.message_local_id = ${Number(localId) || 0}`,
  );
}

function buildAttachPath(accountDir, dir1, dir2, fileName) {
  return path.join(accountDir, "msg", "attach", dir1, dir2, "Img", fileName);
}

function resolveImageAttachPaths(accountDir, talker, imageHash, monthHint = "", hardlinkRows = [], exactOnly = false) {
  if (!accountDir || !talker || !imageHash) return null;
  const month = monthHint || monthDirFromTs(Math.floor(Date.now() / 1000));
  let imgDir = "";

  for (const row of hardlinkRows || []) {
    if (!row?.dir1_name || !row?.file_name) continue;
    const monthDir = row.dir2_name && /^\d{4}-\d{2}$/.test(row.dir2_name) ? row.dir2_name : month;
    imgDir = path.join(accountDir, "msg", "attach", row.dir1_name, monthDir, "Img");
    if (fs.existsSync(imgDir)) break;
  }

  if (!imgDir) {
    const talkerDir = talkerHash(talker);
    imgDir = path.join(accountDir, "msg", "attach", talkerDir, month, "Img");
  }

  const diskHit = exactOnly ? "" : findImageDatOnDisk(accountDir, talker, imageHash, month);
  let baseHash = imageHash;
  if (diskHit) {
    imgDir = path.dirname(diskHit);
    const base = path.basename(diskHit).replace(/(_[ht])?\.dat$/i, "");
    if (base) baseHash = base;
  }

  const thumbWsl = path.join(imgDir, `${baseHash}_t.dat`);
  const extraWsl = path.join(imgDir, `${baseHash}.dat`);
  const extraHWsl = path.join(imgDir, `${baseHash}_h.dat`);
  return {
    imgDir,
    thumbWsl,
    extraWsl,
    extraHWsl,
    thumb: wslToWin(thumbWsl),
    extra: wslToWin(extraWsl),
    extraH: wslToWin(extraHWsl),
  };
}

function pickBestAttachDat(paths, imageHash = "") {
  if (!paths) return "";
  const ranked = sortDatPathsByQuality(
    [paths.extraWsl, paths.extraHWsl, paths.thumbWsl].filter((p) => p && fs.existsSync(p)),
    imageHash,
  );
  return ranked[0] || "";
}

function pickExactAttachDat(paths, imageHash = "") {
  if (!paths) return "";
  // Deliberately exclude *_t.dat. A thumbnail can exist before the native HD
  // request and must never satisfy the exact-attach upgrade path.
  const ranked = sortDatPathsByQuality(
    [paths.extraHWsl, paths.extraWsl].filter((p) => p && fs.existsSync(p)),
    imageHash,
  );
  return ranked[0] || "";
}

async function pollExactAttachDatPaths(paths, maxPolls = 8, imageHash = "") {
  if (!paths) return null;
  for (let i = 0; i < maxPolls; i += 1) {
    const exact = pickExactAttachDat(paths, imageHash);
    if (exact) {
      const size = statSizeSafe(exact);
      if (size > 31) return { path: exact, bytes: size };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function pollAttachDatPaths(paths, minBytes = 0, maxPolls = 240, imageHash = "") {
  if (!paths) return null;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const best = pickBestAttachDat(paths, imageHash);
    if (!best) continue;
    const size = statSizeSafe(best);
    if (size <= 0) continue;
    if (!cdnBytesAcceptable(size, minBytes) && size <= WXGF_BUBBLE_MAX) continue;
    return { path: best, bytes: size };
  }
  return null;
}

async function decodeAttachDatFile(cfg, datWsl, dstWsl) {
  if (!datWsl || !fs.existsSync(datWsl)) return { ok: false, reason: "missing_dat" };
  const dec = decodeViaPython(datWsl, dstWsl);
  if (dec?.ok && fs.existsSync(dstWsl) && isRasterImageFile(dstWsl)) {
    return {
      ok: true,
      out: dstWsl,
      method: "attach-decode-python",
      bytes: fs.statSync(dstWsl).size,
      source_dat: datWsl,
    };
  }
  try {
    const hook = await decodeViaHook(cfg, datWsl, dstWsl, [datWsl]);
    if (hook?.ret === 0 && hook?.bytes > 0 && fs.existsSync(dstWsl) && isRasterImageFile(dstWsl)) {
      return {
        ok: true,
        out: dstWsl,
        method: "attach-decode-hook",
        bytes: fs.statSync(dstWsl).size,
        source_dat: hook.src_used || datWsl,
      };
    }
  } catch {
    // ignore
  }
  return { ok: false, reason: "decode_failed", path_hint: datWsl };
}

async function downloadViaAttach(cfg, opts) {
  const { talker, msgRow, accountDir, imageHash, cdnFields, nickname = "" } = opts;
  if (!cdnFields?.fileid || !cdnFields?.aeskey || !imageHash || !accountDir) return null;

  const monthHint = monthDirFromTs(msgRow.create_time);
  const links = imageHash ? await lookupImageHardlinkAll(cfg, imageHash) : [];
  const paths = resolveImageAttachPaths(accountDir, talker, imageHash, monthHint, links);
  if (!paths) return null;

  const minBytes = Number(cdnFields.hdlength || 0);
  const base = `pc_${talkerHash(talker)}_${msgRow.local_id || 0}_${imageHash.slice(0, 8)}`;
  const dstWsl = path.join(MEDIA_INBOX, `${base}_attach.jpg`);

  const existing = pickBestAttachDat(paths, imageHash);
  if (existing && cdnBytesAcceptable(statSizeSafe(existing), minBytes)) {
    const decoded = await decodeAttachDatFile(cfg, existing, dstWsl);
    if (decoded.ok) {
      const canon = canonicalizeImageFile(decoded.out);
      return {
        ret: 0,
        retmsg: "success; mode=attach_exists",
        method: decoded.method,
        bytes: decoded.bytes,
        ok: true,
        file: canon.file,
        canonical_file: canon.canonical_file,
        file_sha: canon.file_sha,
        decode_bytes: decoded.bytes,
        source_dat: decoded.source_dat || existing,
      };
    }
  }

  const body = {
    id: String(msgRow.local_id || msgRow.localId || 0),
    server_id: String(msgRow.server_id || msgRow.serverId || ""),
    create_time: String(msgRow.create_time || msgRow.createTime || 0),
    talker,
    thumb: paths.thumb,
    extra: paths.extra,
    fileid: cdnFields.fileid,
    aeskey: cdnFields.aeskey,
    fileType: 2,
    msg_type: 3,
    sessionKey: buildCdnSessionKey(talker, msgRow.create_time, msgRow.local_id),
  };

  let hookRes = null;
  try {
    hookRes = await hookRequest(cfg, "/DownloadAttach", body, { timeoutMs: 65000 });
  } catch (err) {
    hookRes = { ret: -404, retmsg: err.message };
  }

  if (hookRes?.bytes > 60000) {
    const hit = pickBestAttachDat(paths, imageHash);
    if (hit) {
      const decoded = await decodeAttachDatFile(cfg, hit, dstWsl);
      if (decoded.ok && cdnBytesAcceptable(decoded.bytes, minBytes)) {
        const canon = canonicalizeImageFile(decoded.out);
        return {
          ret: 0,
          retmsg: hookRes.retmsg || "success; mode=cdn_attach_direct",
          method: decoded.method,
          bytes: decoded.bytes,
          ok: true,
          file: canon.file,
          canonical_file: canon.canonical_file,
          file_sha: canon.file_sha,
          decode_bytes: decoded.bytes,
        };
      }
    }
  }

  if (hookRes?.ret === 404 || String(hookRes?.retmsg || "").includes("404")) {
    hookRes = await registerCdnPending(
      cfg,
      { aeskey: cdnFields.aeskey, fileid: cdnFields.fileid, chatType: 0, largesVideo: 0, fileType: 2 },
      paths.extraWsl,
    );
  }

  console.log(
    `[wechat-bridge] attach download talker=${talker.slice(0, 20)} local_id=${body.id} ret=${hookRes?.ret} msg=${hookRes?.retmsg || hookRes?.method || "?"}`,
  );

  const polled = await pollAttachDatPaths(paths, minBytes, 90, imageHash);
  if (polled) {
    const decoded = await decodeAttachDatFile(cfg, polled.path, dstWsl);
    if (decoded.ok && cdnBytesAcceptable(decoded.bytes, minBytes)) {
      const canon = canonicalizeImageFile(decoded.out);
      return {
        ret: 0,
        retmsg: "success; mode=attach_polled",
        method: decoded.method,
        bytes: decoded.bytes,
        ok: true,
        file: canon.file,
        canonical_file: canon.canonical_file,
        file_sha: canon.file_sha,
        decode_bytes: decoded.bytes,
      };
    }
  }

  return hookRes;
}

const IMAGE_DAT_SUFFIXES = [".dat", "_h.dat", "_t.dat"];

function imageDatSuffixRank(fileName, imageHash) {
  if (fileName === `${imageHash}.dat`) return 0;
  if (fileName.endsWith("_h.dat")) return 1;
  if (fileName.endsWith("_t.dat")) return 2;
  return 3;
}

function statSizeSafe(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function isRasterImageFile(p) {
  try {
    const head = fs.readFileSync(p).subarray(0, 4);
    if (head[0] === 0xff && head[1] === 0xd8) return true;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
    return false;
  } catch {
    return false;
  }
}

function isCompleteRasterImage(p) {
  if (!isRasterImageFile(p)) return false;
  try {
    execFileSync("python3", ["-c",
      "from PIL import Image; import sys; p=sys.argv[1]; im=Image.open(p); im.verify(); im=Image.open(p); im.load(); assert im.width > 0 and im.height > 0",
      p], { timeout: 10000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function sortDatPathsByQuality(paths, imageHash = "") {
  return [...paths].sort((a, b) => {
    const sizeDiff = statSizeSafe(b) - statSizeSafe(a);
    if (sizeDiff !== 0) return sizeDiff;
    const rankDiff =
      imageDatSuffixRank(path.basename(a), imageHash) -
      imageDatSuffixRank(path.basename(b), imageHash);
    if (rankDiff !== 0) return rankDiff;
    return b.localeCompare(a);
  });
}

function resolveImageBubblePath(accountDir, talker, imageHash, monthHint = "") {
  if (!accountDir || !talker || !imageHash) return "";
  const month = monthHint || monthDirFromTs(Math.floor(Date.now() / 1000));
  return path.join(
    accountDir,
    "cache",
    month,
    "Message",
    talkerHash(talker),
    "Bubble",
    `${imageHash}_b.dat`,
  );
}

function rasterContentSimilarity(a, b) {
  if (!a || !b || !fs.existsSync(a) || !fs.existsSync(b)) return null;
  try {
    const raster = (file) => execFileSync(
      "convert",
      [file, "-auto-orient", "-resize", "64x64!", "-colorspace", "Gray", "-depth", "8", "gray:-"],
      { encoding: null, timeout: 15000, maxBuffer: 64 * 1024 },
    );
    const left = raster(a);
    const right = raster(b);
    const n = Math.min(left.length, right.length);
    if (!n) return null;
    let delta = 0;
    for (let i = 0; i < n; i += 1) delta += Math.abs(left[i] - right[i]);
    return 1 - delta / (255 * n);
  } catch {
    return null;
  }
}

function selectConsistentImageCandidate(candidates, imageHash = "", log = console.log) {
  const bubble = candidates.find((item) => String(item.dat || "").endsWith("_b.dat"));
  const eligible = candidates.filter((item) => {
    if (!bubble || item === bubble) return true;
    const similarity = rasterContentSimilarity(bubble.out, item.out);
    if (similarity == null || similarity >= 0.78) return true;
    log(
      `[wechat-bridge] reject mismatched image variant hash=${String(imageHash).slice(0, 8)} ` +
        `source=${path.basename(item.dat)} similarity=${similarity.toFixed(3)}`,
    );
    return false;
  });
  return eligible.sort((a, b) => b.tier - a.tier || b.size - a.size)[0] || null;
}

function monthDirFromTs(tsSec) {
  const t = Number(tsSec || 0);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = new Date(t > 1e11 ? t : t * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function pickImageDatInDir(imgDir, imageHash) {
  const hits = listImageDatNamesInDir(imgDir, imageHash);
  return hits[0] ? path.join(imgDir, hits[0]) : "";
}

function listImageDatNamesInDir(imgDir, imageHash) {
  if (!imgDir || !fs.existsSync(imgDir)) return [];
  const exact = IMAGE_DAT_SUFFIXES.map((s) => `${imageHash}${s}`);
  const found = [];
  for (const name of exact) {
    if (fs.existsSync(path.join(imgDir, name))) found.push(name);
  }
  try {
    for (const name of fs.readdirSync(imgDir)) {
      if (name.startsWith(imageHash) && name.endsWith(".dat") && !found.includes(name)) {
        found.push(name);
      }
    }
  } catch {
    // ignore
  }
  const rank = (n) => imageDatSuffixRank(n, imageHash);
  const withSize = found.map((name) => ({
    name,
    size: statSizeSafe(path.join(imgDir, name)),
    rank: rank(name),
  }));
  return withSize
    .sort((a, b) => b.size - a.size || a.rank - b.rank || b.name.length - a.name.length)
    .map((x) => x.name);
}

function findImageDatOnDisk(accountDir, talker, imageHash, monthHint = "") {
  if (!accountDir || !imageHash) return "";
  const talkerDir = talkerHash(talker);
  const attachRoot = path.join(accountDir, "msg", "attach");
  const monthDirs = [];
  if (monthHint) monthDirs.push(monthHint);
  const talkerAttach = path.join(attachRoot, talkerDir);
  if (fs.existsSync(talkerAttach)) {
    for (const name of fs.readdirSync(talkerAttach)) {
      if (/^\d{4}-\d{2}$/.test(name) && !monthDirs.includes(name)) monthDirs.push(name);
    }
    monthDirs.sort((a, b) => b.localeCompare(a));
  }

  const candidates = [];
  for (const month of monthDirs) {
    for (const name of listImageDatNamesInDir(path.join(talkerAttach, month, "Img"), imageHash)) {
      candidates.push(path.join(talkerAttach, month, "Img", name));
    }
  }

  if (!fs.existsSync(attachRoot)) return candidates[0] || "";
  for (const dir1 of fs.readdirSync(attachRoot)) {
    for (const month of monthDirs.length ? monthDirs : fs.readdirSync(path.join(attachRoot, dir1)).filter((n) => /^\d{4}-\d{2}$/.test(n))) {
      for (const name of listImageDatNamesInDir(path.join(attachRoot, dir1, month, "Img"), imageHash)) {
        const p = path.join(attachRoot, dir1, month, "Img", name);
        if (!candidates.includes(p)) candidates.push(p);
      }
    }
  }
  return sortDatPathsByQuality(candidates, imageHash)[0] || "";
}

function listImageDatPaths(accountDir, talker, imageHash, monthHint = "") {
  const primary = findImageDatOnDisk(accountDir, talker, imageHash, monthHint);
  if (!primary) return [];
  const talkerDir = talkerHash(talker);
  const attachRoot = path.join(accountDir, "msg", "attach");
  const monthDirs = monthHint ? [monthHint] : [];
  const talkerAttach = path.join(attachRoot, talkerDir);
  if (fs.existsSync(talkerAttach)) {
    for (const name of fs.readdirSync(talkerAttach)) {
      if (/^\d{4}-\d{2}$/.test(name) && !monthDirs.includes(name)) monthDirs.push(name);
    }
  }
  const out = [];
  for (const month of monthDirs) {
    for (const name of listImageDatNamesInDir(path.join(talkerAttach, month, "Img"), imageHash)) {
      const p = path.join(talkerAttach, month, "Img", name);
      if (!out.includes(p)) out.push(p);
    }
  }
  return sortDatPathsByQuality(out.length ? out : primary ? [primary] : [], imageHash);
}

function canonicalizeImageFile(srcPath) {
  const buf = fs.readFileSync(srcPath);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const canonDir = path.join(WORKSPACE_WECHAT, "media", "by_sha", sha.slice(0, 2));
  const canon = path.join(canonDir, `${sha}.jpg`);
  fs.mkdirSync(canonDir, { recursive: true });
  if (!fs.existsSync(canon)) fs.copyFileSync(srcPath, canon);
  return { file_sha: sha, file: canon, canonical_file: canon };
}

function canonicalizeAttachmentFile(srcPath) {
  const buf = fs.readFileSync(srcPath);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const ext = path.extname(srcPath).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
  const canonDir = path.join(WORKSPACE_WECHAT, "media", "by_sha", sha.slice(0, 2));
  const canon = path.join(canonDir, `${sha}${ext}`);
  fs.mkdirSync(canonDir, { recursive: true });
  if (!fs.existsSync(canon)) fs.copyFileSync(srcPath, canon);
  return { file_sha: sha, file: canon, canonical_file: canon };
}

function buildFilePath(accountDir, monthDir, fileName) {
  return path.join(accountDir, "msg", "file", monthDir, fileName);
}

function decodeViaHook(cfg, srcWsl, dstWsl, srcPaths = []) {
  const body = {
    dst_path: wslToWin(dstWsl),
  };
  const all = sortDatPathsByQuality(
    [...new Set([srcWsl, ...srcPaths].filter(Boolean))],
    "",
  );
  if (all.length > 1) {
    body.src_paths = all.map(wslToWin);
  } else if (all[0]) {
    body.src_path = wslToWin(all[0]);
  }
  return hookRequest(cfg, "/Decode_Pic", body);
}

function decodeViaPython(srcWsl, dstWsl) {
  try {
    const out = execFileSync(
      "python3",
      [DECRYPT_SCRIPT, "--in", srcWsl, "--out", dstWsl, "--json"],
      { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(out.trim());
    if (parsed?.ok && parsed.out && fs.existsSync(parsed.out)) {
      return parsed;
    }
    return parsed;
  } catch (err) {
    const text = String(err.stdout || err.stderr || err.message || "");
    try {
      return JSON.parse(text.trim());
    } catch {
      return { ok: false, error: text.slice(0, 300) };
    }
  }
}

function appendManifest(entry) {
  entry = stampImageFileIdentity(entry);
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(MANIFEST_LOCK_DIR);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const ageMs = Date.now() - fs.statSync(MANIFEST_LOCK_DIR).mtimeMs;
        if (ageMs > 15000) {
          fs.rmdirSync(MANIFEST_LOCK_DIR);
          continue;
        }
      } catch (staleErr) {
        if (staleErr.code !== "ENOENT" && staleErr.code !== "ENOTEMPTY") throw staleErr;
      }
      if (attempt >= 1500) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const rows = [];
    if (fs.existsSync(MANIFEST_PATH)) {
      for (const line of fs.readFileSync(MANIFEST_PATH, "utf8").split("\n")) {
        if (line.trim()) rows.push(JSON.parse(line));
      }
    }
    const id =
      entry.id ||
      entry.message_key ||
      `${entry.talker}|${entry.ts}|${entry.capture_id || ""}|${(entry.placeholder || entry.content || "").slice(0, 40)}`;
    entry.id = id;
    entry.registered_at = entry.registered_at || new Date().toISOString();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const prev = rows[idx];
      const merged = mergeManifestEntryMonotonic(prev, entry, id);
      const improved =
        (entry.file && !prev.file) ||
        (entry.status === "pending" && prev.status === "missing") ||
        (entry.path_hint && !prev.path_hint) ||
        (Number(entry.decode_bytes || 0) > Number(prev.decode_bytes || 0)) ||
        (entry.file_sha && entry.file_sha !== prev.file_sha && Number(entry.decode_bytes || 0) >= Number(prev.decode_bytes || 0));
      if (improved || JSON.stringify(prev) !== JSON.stringify(merged)) {
        rows[idx] = merged;
        const tmp = `${MANIFEST_PATH}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
        fs.renameSync(tmp, MANIFEST_PATH);
      }
      return id;
    }
    fs.appendFileSync(MANIFEST_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    return id;
  } finally {
    fs.rmdirSync(MANIFEST_LOCK_DIR);
  }
}

function normalizeBridgeTs(ts) {
  let t = Number(ts);
  if (!Number.isFinite(t)) return Date.now();
  if (t < 1e12) t *= 1000;
  return t;
}

let distillChild = null;
const distillQueue = new Map();
const distillRetryTimers = new Map();
const DISTILL_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.WECHAT_DISTILL_TIMEOUT_MS || 180_000),
);
const DISTILL_BATCH_LIMIT = Math.max(
  1,
  Number(process.env.WECHAT_DISTILL_BATCH_LIMIT || 3),
);
const DISTILL_BACKLOG_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.WECHAT_DISTILL_BACKLOG_INTERVAL_MS || 120_000),
);

function distillTargetKey(messageKey, fileSha) {
  return `${messageKey || ""}\n${fileSha || ""}`;
}

function scheduleDistillRetry(target, fallbackDelayMs = 0) {
  if (!target?.messageKey && !target?.fileSha) return;
  const key = distillTargetKey(target.messageKey, target.fileSha);
  const row = loadManifestRows().find((item) => {
    const sameKey = !target.messageKey || (item.message_key || item.id || "") === target.messageKey;
    const sameSha = !target.fileSha || (item.file_sha || "") === target.fileSha;
    return sameKey && sameSha;
  });
  if (row?.media_repair_requested_at || Number(row?.vision_attempts || 0) >= 2) return;
  if (!fallbackDelayMs && row?.vision_state !== "retry") return;
  const retryAt = row?.vision_next_retry_at ? Date.parse(row.vision_next_retry_at) : 0;
  const delayMs = Math.max(1000, fallbackDelayMs || retryAt - Date.now() || 30000);
  if (distillRetryTimers.has(key)) clearTimeout(distillRetryTimers.get(key));
  const timer = setTimeout(() => {
    distillRetryTimers.delete(key);
    triggerDistill(target.messageKey, target.fileSha);
  }, Math.min(delayMs, 0x7fffffff));
  timer.unref?.();
  distillRetryTimers.set(key, timer);
}

function startNextDistill() {
  const script = path.join(WORKSPACE_WECHAT, "skills/wechat-media/distill_media.py");
  if (!fs.existsSync(script)) return;
  if (distillChild && distillChild.exitCode === null) return;
  const next = distillQueue.values().next().value;
  if (!next) return;
  distillQueue.delete(distillTargetKey(next.messageKey, next.fileSha));
  try {
    const focused = Boolean(next.messageKey || next.fileSha);
    const args = [
      script,
      "--once",
      "--limit",
      focused ? "1" : String(DISTILL_BATCH_LIMIT),
      "--pc-only",
    ];
    if (next.messageKey) args.push("--message-key", next.messageKey);
    if (next.fileSha) args.push("--file-sha", next.fileSha);
    const child = spawn("python3", args, {
      detached: true,
      stdio: "ignore",
    });
    distillChild = child;
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (child.exitCode !== null) return;
      timedOut = true;
      const retryAt = new Date(Date.now() + 300_000).toISOString();
      const current = loadManifestRows().find((row) =>
        (next.messageKey && (row.message_key || row.id) === next.messageKey) ||
        (next.fileSha && row.file_sha === next.fileSha),
      );
      if (current && !["done", "filtered"].includes(current.status)) {
        appendManifest({
          ...current,
          status: "pending",
          vision_state: "retry",
          vision_last_error: "distill-timeout",
          vision_next_retry_at: retryAt,
          updated_at: new Date().toISOString(),
        });
      }
      console.error(
        `[wechat-bridge] distill timeout after ${DISTILL_TIMEOUT_MS}ms ` +
          `key=${next.messageKey || "-"} sha=${next.fileSha || "-"}`,
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000).unref?.();
    }, DISTILL_TIMEOUT_MS);
    timeout.unref?.();
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (distillChild === child) distillChild = null;
      scheduleDistillRetry(next, code === 0 ? 0 : timedOut ? 300000 : 30000);
      if (distillQueue.size) setImmediate(startNextDistill);
    });
    child.once("error", () => {
      if (distillChild === child) distillChild = null;
      distillQueue.set(distillTargetKey(next.messageKey, next.fileSha), next);
      if (distillQueue.size) setImmediate(startNextDistill);
    });
    child.unref();
  } catch {
    // async best-effort
  }
}

function triggerDistill(messageKey = "", fileSha = "") {
  const targetKey = distillTargetKey(messageKey, fileSha);
  distillQueue.set(targetKey, { messageKey, fileSha });
  startNextDistill();
}

// New media keeps the focused fast path.  When it is idle, periodically
// drain historical pending rows so an old backlog cannot starve forever.
const distillBacklogTimer = setInterval(() => {
  if (distillChild && distillChild.exitCode === null) return;
  if (distillQueue.size) return;
  const key = distillTargetKey("", "");
  distillQueue.set(key, { messageKey: "", fileSha: "" });
  startNextDistill();
}, DISTILL_BACKLOG_INTERVAL_MS);
distillBacklogTimer.unref?.();

async function materializeImage(cfg, accountDir, talker, msgRow, resources) {
  const blobs = [msgRow.message_content, msgRow.packed_info_data,
    ...(resources || []).map(r => r.detail_info || r.packed_info)];
  const cdnFields = extractImageCdnFields(...blobs);
  const imageHash = extractImageHash(...(resources || []).map(r => r.packed_info)) ||
    extractImageHash(msgRow.packed_info_data);
  const metadata = { kind: "image", image_hash: imageHash || null,
    target_tier: "middle", hd_requested: false, hd_pending: false,
    cdn_middle_fileid: cdnFields?.fileid || null,
    middle_expected_bytes: Number(cdnFields?.length || 0) || null };
  if (!imageHash && !cdnFields?.fileid) return { ...metadata, ok: false, middle_pending: true, reason: "no_image_identity" };
  const links = imageHash ? await lookupImageHardlinkAll(cfg, imageHash) : [];
  const month = monthDirFromTs(msgRow.create_time);
  const exact = resolveImageAttachPaths(accountDir, talker, imageHash, month, links, true);
  const candidates = [exact?.extraWsl, exact?.thumbWsl,
    ...(imageHash ? listImageDatPaths(accountDir, talker, imageHash, month) : []),
    ...links.filter(r => r.dir1_name && r.file_name).map(r => buildAttachPath(accountDir, r.dir1_name, r.dir2_name, r.file_name))];
  const bubble = resolveImageBubblePath(accountDir, talker, imageHash, month);
  const nativeTemps = ["mid_temp_convert", "mid_temp"].map(suffix =>
    resolveImageCacheTempPath(accountDir, talker, msgRow.local_id, msgRow.create_time, suffix)?.wsl);
  // Exact native message path or the exact cdnmidimgurl FNV identity only.
  // Never search adjacent images or use HD as a substitute.
  const middle = [...new Set([
    ...candidates.filter(p => p && imageHash && path.basename(p) === `${imageHash}.dat`),
    ...nativeTemps,
    cdnFields?.fileid ? hookAutoInboxPath(cdnFields.fileid).replace(/\.jpg$/, ".middle.jpg") : null,
  ])].filter(p => p && fs.existsSync(p));
  const thumbs = [...new Set([...candidates, bubble])].filter(p => p &&
    [`${imageHash}_t.dat`, `${imageHash}_b.dat`].includes(path.basename(p)) && fs.existsSync(p));
  fs.mkdirSync(MEDIA_INBOX, { recursive: true });
  const decodedCandidates = [];
  // One exact middle and one content baseline suffice; originals are excluded.
  for (const [tier, sources] of [[2, middle], [1, thumbs]]) {
    for (const src of sources) {
      const dst = path.join(MEDIA_INBOX, `pc_${talkerHash(talker)}_${msgRow.local_id}_${(imageHash || fileidInboxStem(cdnFields.fileid)).slice(0,8)}_${tier === 2 ? "middle" : "thumb"}.jpg`);
      const decoded = decodeViaPython(src, dst);
      const out = decoded?.out || dst;
      if (!decoded?.ok || !isCompleteRasterImage(out)) continue;
      decodedCandidates.push({ decoded, out, size: statSizeSafe(out), tier, dat: src });
      break;
    }
  }
  const selected = selectConsistentImageCandidate(decodedCandidates, imageHash);
  if (!selected) return { ...metadata, ok: false, middle_pending: true, reason: "waiting_native_middle_cache" };
  const canon = canonicalizeImageFile(selected.out);
  const isMiddle = selected.tier === 2;
  return { ...metadata, ...canon, ok: true, method: selected.decoded.method,
    source_dat: selected.dat, decode_bytes: selected.size,
    captured_tier: isMiddle ? "middle" : "thumbnail", middle_pending: !isMiddle };
}

async function materializeFile(cfg, accountDir, talker, msgRow, resources) {
  const metadata = attachmentMetadata(msgRow.message_content);
  const names = new Set();
  for (const r of resources || []) {
    for (const n of extractAttachmentFileNames(r.detail_info, r.packed_info)) names.add(n);
  }
  for (const n of extractAttachmentFileNames(msgRow.packed_info_data, msgRow.message_content)) {
    names.add(n);
  }

  if (metadata.file_name) {
    names.clear();
    names.add(metadata.file_name);
  }
  const rejectionReasons = new Set();
  for (const fileName of names) {
    if (fileName !== path.basename(fileName) || /[\\/]/.test(fileName)) {
      rejectionReasons.add("attachment-name-invalid");
      continue;
    }
    const link = await lookupFileHardlink(cfg, fileName);
    const month = link?.dir1_name || "";
    const candidates = [];
    if (link && month) candidates.push(buildFilePath(accountDir, month, fileName));
    if (month) {
      const alt = path.join(accountDir, "msg", "file", month, fileName);
      if (!candidates.includes(alt)) candidates.push(alt);
    }
    const globRoot = path.join(accountDir, "msg", "file");
    if (fs.existsSync(globRoot)) {
      for (const monthDir of fs.readdirSync(globRoot)) {
        const p = path.join(globRoot, monthDir, fileName);
        if (fs.existsSync(p)) candidates.push(p);
      }
    }

    const valid = [...new Set(candidates)].filter(p => {
      try {
        const stat = fs.statSync(p);
        if (!stat.isFile() || !stat.size) { rejectionReasons.add("attachment-empty-or-not-file"); return false; }
        if (metadata.file_size && stat.size !== metadata.file_size) { rejectionReasons.add("attachment-size-mismatch"); return false; }
        if (/^[a-f0-9]{32}$/i.test(metadata.file_md5 || "")) {
          const valid = crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex") === metadata.file_md5.toLowerCase();
          if (!valid) rejectionReasons.add("attachment-md5-mismatch");
          return valid;
        }
        return true;
      } catch { return false; }
    });
    if (!valid.length && metadata.file_size > 0 && /^[a-f0-9]{32}$/i.test(metadata.file_md5 || "")) {
      // Weixin may rename a received file. Names and sizes alone are never
      // source evidence: fall back only to the original message's full MD5.
      const nativeRoot = path.join(accountDir, "msg", "file");
      if (fs.existsSync(nativeRoot)) for (const monthEntry of fs.readdirSync(nativeRoot, {withFileTypes:true})) {
        if (!monthEntry.isDirectory()) continue;
        const monthPath = path.join(nativeRoot, monthEntry.name);
        for (const candidate of fs.readdirSync(monthPath, {withFileTypes:true})) {
          if (!candidate.isFile()) continue;
          const source = path.join(monthPath, candidate.name);
          if (fs.statSync(source).size !== metadata.file_size) continue;
          const hit = await require("./native-file-digests.js").nativeFileDigests(source);
          if (hit && hit.size === metadata.file_size && hit.md5 === metadata.file_md5.toLowerCase()) valid.push(source);
        }
      }
    }
    if (!valid.length) continue;
    if (valid.length > 1) {
      const hashes = new Set(valid.map(p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")));
      if (hashes.size !== 1) return {ok:false, reason:"attachment-cache-ambiguous", names:[...names]};
    }
    const hit = valid[0];

    fs.mkdirSync(MEDIA_INBOX, { recursive: true });
    const safe = fileName.replace(/[^\w\u4e00-\u9fff.\-()+]/g, "_");
    const dest = path.join(MEDIA_INBOX, `pc_${talkerHash(talker)}_${msgRow.local_id}_${safe}`);
    // A former resolution may have left stale/wrong bytes at this name.
    // Verify the copied result as well as the source before reporting success.
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(hit)).digest("hex");
    if (!fs.existsSync(dest) || crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex") !== sourceHash) {
      const temp = dest + ".copy-" + process.pid;
      try {
        fs.copyFileSync(hit, temp);
        if (crypto.createHash("sha256").update(fs.readFileSync(temp)).digest("hex") !== sourceHash) {
          return {ok:false, reason:"attachment-changed-during-copy", names:[...names]};
        }
        fs.renameSync(temp, dest);
      } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    const canon = canonicalizeAttachmentFile(dest);
    return {
      ok: true,
      kind: "file",
      file: canon.file,
      canonical_file: canon.canonical_file,
      file_sha: canon.file_sha,
      file_name: fileName,
      source: hit,
      method: "wechat-file-cache",
    };
  }

  return { ok: false, reason: [...rejectionReasons][0] || (metadata.file_name ? "file_not_found" : "attachment-metadata-missing"), names: [...names] };
}

async function materializeVideo(cfg, accountDir, talker, msgRow) {
  let metadata;
  try {
    metadata = JSON.parse(execFileSync("python3", [path.join(__dirname, "scripts", "decode-wechat-video-message.py")], {
      input: JSON.stringify({raw: msgRow.message_content}), encoding: "utf8",
      timeout: 8000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch { return {ok:false, reason:"video-message-metadata-invalid"}; }
  if (!metadata.ok) return {ok:false, reason:metadata.error};
  const expected = new Set(metadata.identities.map(item => item.md5));
  const videoRoot = path.join(accountDir, "msg", "video");
  const folder = path.join(videoRoot, monthDirFromTs(msgRow.create_time));
  const matches = [];
  async function scanVideoFolder(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
      const source = path.join(directory, entry.name);
      const hit = await require("./native-file-digests.js").nativeFileDigests(source);
      if (hit && expected.has(hit.md5)) matches.push(hit);
    }
  }
  await scanVideoFolder(folder);
  // Native downloads may be cached under their download month. The exact
  // message's full MD5 is still mandatory; neither month nor name is proof.
  if (!matches.length && fs.existsSync(videoRoot)) {
    for (const month of fs.readdirSync(videoRoot, {withFileTypes:true})) {
      if (!month.isDirectory()) continue;
      const other = path.join(videoRoot, month.name);
      if (other !== folder) await scanVideoFolder(other);
    }
  }
  if (!matches.length) return {ok:false, reason:"video-cache-not-found"};
  // md5/newmd5/rawmd5 can describe different encodings of this exact clip.
  // Prefer the current md5, then the named alternatives; do not mistake two
  // explicitly identified encodings for two unrelated source messages.
  const digest = metadata.identities.find(item => matches.some(hit => hit.md5 === item.md5)).md5;
  const selected = matches.filter(item => item.md5 === digest);
  if (new Set(selected.map(item => item.sha)).size !== 1) return {ok:false, reason:"video-cache-ambiguous"};
  const hit = selected[0];
  const dir = path.join(WORKSPACE_WECHAT, "media", "by_sha", hit.sha.slice(0,2));
  fs.mkdirSync(dir, {recursive:true});
  const target = path.join(dir, hit.sha + ".mp4");
  const temporary = target + ".copy-" + process.pid;
  try {
    await fs.promises.copyFile(hit.source, temporary);
    const copied = crypto.createHash("sha256");
    for await (const block of fs.createReadStream(temporary)) copied.update(block);
    if (copied.digest("hex") !== hit.sha) return {ok:false, reason:"video-changed-during-copy"};
    await fs.promises.rename(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return {ok:true, kind:"video", file:target, canonical_file:target, file_sha:hit.sha,
    method:"wechat-video-cache-md5", decode_bytes:hit.size,
    attachment_byte_evidence:{kind:"video-xml-md5-and-local-cache", md5:hit.md5, sha256:hit.sha, size:hit.size}};
}

async function enrichEventMedia(cfg, event, msgRow) {
  if (!msgRow || !isMediaPayload(msgRow.message_content || event.content, msgRow.local_type ?? event.type)) {
    return event;
  }

  const kind = mediaKind(msgRow.local_type ?? event.type);
  if (kind === "app_card") return enrichAppCardEvent(cfg, event, msgRow);
  const placeholder = mediaPlaceholder(msgRow.local_type ?? event.type);
  event.type = msgRow.local_type ?? event.type;
  event.content = placeholder;
  event.media_kind = kind;

  let existingVideo = null;
  if (kind === "video") {
    const identity = buildMediaMessageKey(event.talker, msgRow);
    const tsSec = Number(msgRow.create_time ?? 0);
    const tsMs = event.ts != null ? normalizeBridgeTs(event.ts) : tsSec * 1000;
    const oldRows = loadManifestRows();
    const existing = oldRows.findLast(row => (row.message_key || row.id) === identity);
    existingVideo = existing;
    // A weak legacy row at the same second needs independent source recovery.
    // Do not create a second queue record or guess which source it represented.
    const weak = oldRows.some(row => row.kind === "video" && row.talker === event.talker &&
      Number(row.ts) === tsMs && !row.local_id && !row.server_id && (row.message_key || row.id) !== identity);
    if (!existing && weak) {
      event.media_status = "legacy-video-source-reconciliation-required";
      return event;
    }
    event.media_message_key = identity;
    event.media_message_ts_ms = tsMs;
    event.media_create_time = tsSec;
    event.media_local_id = Number(msgRow.local_id ?? event.local_id ?? 0);
    event.media_server_id = String(msgRow.server_id ?? msgRow.msg_svr_id ?? event.msg_svr_id ?? "");
    if (existing && ["done", "filtered"].includes(existing.status)) {
      event.media_path = existing.file || existing.canonical_file || null;
      event.media_file_sha256 = existing.file_sha || null;
      event.media_status = event.media_path ? "ready" : existing.status;
      return event;
    }
    appendManifest({id:identity, message_key:identity, talker:event.talker, ts:tsMs,
      message_ts_ms:tsMs, message_create_time:tsSec, local_id:event.media_local_id,
      server_id:event.media_server_id, source_db:msgRow.message_db || null,
      original_content:msgRow.message_content || null, packed_info_data:msgRow.packed_info_data || null,
      content:placeholder, placeholder, kind, source:"pc-hook", status:"pending",
      vision_state:"waiting_media", attachment_failure_reason:"source-resolution-not-started"});
  }

  // Register the exact image identity before any filesystem, CDN, or resource
  // query. Those operations can fail before the resolver can build its final
  // row; without this durable placeholder the calendar worker only sees
  // ``no-manifest-image`` and cannot distinguish missing bytes from a lost
  // manifest entry.
  let existingManifest = null;
  if (kind === "image") {
    const existingKey = buildMediaMessageKey(event.talker, msgRow);
    existingManifest = loadManifestRows().findLast(row => (row.message_key || row.id) === existingKey);
    const existingFile = existingManifest?.file || existingManifest?.canonical_file || null;
    const existingMiddleIsComplete = effectiveCapturedTier(existingManifest || {}) !== "middle" ||
      !existingFile || !fs.existsSync(existingFile) || isCompleteRasterImage(existingFile);
    if (existingManifest && existingMiddleIsComplete && !imageNeedsSourceWork(existingManifest, readImageDemands())) {
      // Re-polling a completed prescreen must not reset it to pending or
      // replace its bytes just because a better cache file has appeared.
      event.media_message_key = existingKey;
      event.media_path = existingManifest.file || existingManifest.canonical_file || null;
      event.media_status = event.media_path ? "ready" : existingManifest.status;
      event.media_file_sha256 = existingManifest.file_sha || null;
      event.media_image_hash = existingManifest.image_hash || null;
      event.media_hd_pending = false;
      event.media_middle_pending = existingManifest.captured_tier === "thumbnail";
      event.media_captured_tier = existingManifest.captured_tier || null;
      event.media_method = "reuse_completed_prescreen";
      return event;
    }
    const tsSec = Number(msgRow.create_time ?? msgRow.createTime ?? 0);
    const tsMs = event.ts != null ? normalizeBridgeTs(event.ts) : (tsSec > 1e11 ? tsSec : tsSec * 1000);
    const localId = Number(msgRow.local_id ?? msgRow.localId ?? event.local_id ?? 0);
    const serverId = String(msgRow.server_id ?? msgRow.serverId ?? msgRow.msg_svr_id ?? event.server_id ?? event.msg_svr_id ?? "");
    const messageCreateTime = Number(msgRow.create_time ?? msgRow.createTime ?? Math.floor(tsMs / 1000));
    const messageKey = existingKey || buildMediaMessageKey(event.talker, {
      local_id: localId, server_id: serverId, create_time: messageCreateTime,
    });
    if (!existingManifest) {
      appendManifest({
        id: messageKey,
        message_key: messageKey,
        talker: event.talker,
        ts: tsMs || Date.now(),
        message_ts_ms: tsMs || Date.now(),
        message_create_time: messageCreateTime,
        local_id: localId,
        server_id: serverId,
        content: placeholder,
        placeholder,
        kind: "image",
        status: "pending",
        vision_state: "waiting_media",
        attachment_failure_class: "attachment_unresolved",
        attachment_failure_reason: "source-resolution-not-started",
        source: "pc-hook",
      });
    }
  }

  const root = await getFilesRoot(cfg);
  const wxid = cfg.wechat_account_wxid || cfg.self_wxid || cfg.pc_login_wxid || "";
  const accountDir = findAccountDir(root, wxid);
  if (!accountDir) {
    event.media_status = "no_account_dir";
    return event;
  }

  if (kind === "image") {
    try {
      await triggerImageCdnDownload(cfg, event.talker, msgRow, event.nickname);
    } catch (err) {
      // CDN prompting is opportunistic. Preserve the pending manifest row and
      // continue through the native resolver so a transient Hook error cannot
      // erase the message identity or abort delivery.
      event.media_cdn_error = String(err.message || err).slice(0, 240);
    }
  }

  let resources = [];
  let result;
  // Retry delayed Weixin resource rows and cached files instead of permanently
  // converting a startup race into file_not_found.
  const fileResolveDelaysMs = [0]; // Cache races use the bounded idle retry queue, never block live messages.
  let lastResolveError = null;
  for (let attempt = 0; attempt < fileResolveDelaysMs.length; attempt += 1) {
    if (fileResolveDelaysMs[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, fileResolveDelaysMs[attempt]));
    try {
      resources = kind === "video" ? [] : await fetchMessageResources(cfg, event.talker, msgRow.local_id ?? event.local_id);
      if (kind === "image") {
        result = await materializeImage(cfg, accountDir, event.talker, msgRow, resources);
        // Native caches are read-only; do not backfill or synthesize HD metadata.
      } else if (kind === "file") {
        result = await materializeFile(cfg, accountDir, event.talker, msgRow, resources);
      } else if (kind === "video") {
        result = await materializeVideo(cfg, accountDir, event.talker, msgRow);
      } else {
        event.media_status = "unsupported_kind";
        return event;
      }
      if (result?.ok || kind !== "file") break;
      lastResolveError = result?.reason || "file_not_found";
    } catch (err) {
      lastResolveError = err;
      if (kind !== "file") {
        // Persist the failed attachment as well as its exact message identity.
        // Returning here used to leave no manifest row for calendar or source
        // recovery, turning a missing cache file into no-manifest-image.
        result = { ok: false, reason: `media-resolve-${err.code || err.name || "error"}`,
          resolver_error: err.message,
          image_hash: extractImageHash(...resources.map(r => r.packed_info), msgRow.packed_info_data) || null,
          middle_pending: true, target_tier: "middle" };
        break;
      }
    }
  }
  if (!result) {
    event.media_status = "resource_query_failed";
    event.media_error = lastResolveError?.message || String(lastResolveError || "attachment-resolve-failed");
    return event;
  }

  const tsSec = Number(msgRow.create_time || 0);
  const tsMs =
    event.ts != null
      ? normalizeBridgeTs(event.ts)
      : tsSec > 1e11
        ? tsSec
        : tsSec * 1000;
  const localId = Number(msgRow.local_id ?? msgRow.localId ?? event.local_id ?? 0);
  const serverId = String(msgRow.server_id ?? msgRow.serverId ?? msgRow.msg_svr_id ?? event.server_id ?? event.msg_svr_id ?? "");
  const messageCreateTime = Number(msgRow.create_time ?? msgRow.createTime ?? Math.floor(tsMs / 1000));
  const messageKey = buildMediaMessageKey(event.talker, {
    local_id: localId,
    server_id: serverId,
    create_time: messageCreateTime,
  });
  const firstSeenAtMs = Date.now();
  const talkerPolicy = resolveTalkerPolicy(event.talker, event.nickname || "");
  const visionCfg = talkerPolicy.media?.vision || {};
  const chatLabel = displayNameForTalker(
    event.talker,
    event.nickname || "",
    cfg.group_display_names || {},
  );
  const senderLabel = event.sender_display || (event.sender ? displayNameForSender(event.sender, "", event.talker) : "");
  const explicitImageDemand = kind === "image" && imageIsRequested({
    message_key: messageKey,
    id: messageKey,
    talker: event.talker,
    file_sha: result.file_sha || null,
    middle_sha256: result.middle_sha256 || null,
    full_sha256: result.full_sha256 || null,
  }, readImageDemands());
  const adSourceFiltered = ["image", "file", "video", "audio"].includes(kind) &&
    talkerPolicy.content_pool === "spam" && !explicitImageDemand;
  const videoReplayBlocked = kind === "video" && (Number(existingVideo?.vision_attempts || 0) >= 2 ||
    !!existingVideo?.backlog_api_job || existingVideo?.completion_validation_failure?.automatic_replay_blocked === true);
  const manifest = {
    id: messageKey,
    message_key: messageKey,
    talker: event.talker,
    ts: tsMs || Date.now(),
    message_ts_ms: tsMs || Date.now(),
    message_create_time: messageCreateTime,
    local_id: localId,
    server_id: serverId,
    first_seen_at_ms: firstSeenAtMs,
    time: new Date(tsMs || Date.now()).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    nickname: chatLabel,
    group_label: chatLabel,
    sender: event.sender || null,
    sender_label: senderLabel || null,
    content_pool: talkerPolicy.content_pool || "private",
    vision_priority: visionCfg.priority ?? (talkerPolicy.content_pool === "work" ? 0 : talkerPolicy.content_pool === "spam" ? 2 : 1),
    allow_gemini: visionCfg.allow_gemini !== false,
    vision_local_only: visionCfg.local_only === true,
    tags: {
      date: new Date(tsMs || Date.now()).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      ts: tsMs || Date.now(),
      talker: event.talker,
      group_label: chatLabel,
      sender_label: senderLabel || undefined,
      content_pool: talkerPolicy.content_pool || "private",
      vision_priority: visionCfg.priority ?? 1,
    },
    content: placeholder,
    original_content: msgRow.message_content || null,
    packed_info_data: msgRow.packed_info_data || null,
    placeholder,
    kind,
    // Attachment resolution can race Weixin's cache. Failed rows stay pending;
    // the persistent source-attempt budget stops automatic retries separately.
    status: "pending",
    path_hint: result.file || result.path_hint || null,
    image_hash: result.image_hash || null,
    file_sha: result.file_sha || null,
    canonical_file: result.canonical_file || result.file || null,
    decode_bytes: result.decode_bytes || null,
    hd_pending: false,
    hd_requested: false,
    target_tier: kind === "image" ? "middle" : undefined,
    middle_pending: kind === "image" ? !!result.middle_pending : undefined,
    cdn_middle_fileid: result.cdn_middle_fileid || null,
    source_dat: result.source_dat || null,
    captured_tier: result.captured_tier || null,
    promoted_middle_reconciled: result.promoted_middle_reconciled || false,
    expected_full_bytes: result.expected_full_bytes || result.hdlength || null,
    middle_expected_bytes: result.middle_expected_bytes || null,
    hdlength: result.hdlength || null,
    file_name: result.file_name || null,
    attachment_byte_evidence: result.attachment_byte_evidence || undefined,
    media_error: result.ok ? null : `attachment-unresolved:${result.reason || "unknown"}`,
    vision_state: videoReplayBlocked ? existingVideo.vision_state : (adSourceFiltered ? "filtered_ad_source" : (result.ok ? "retry" : "waiting_media")),
    vision_last_error: videoReplayBlocked ? existingVideo.vision_last_error : (adSourceFiltered ? "filtered-ad-source-policy" : (result.ok ? null : `attachment-unresolved:${result.reason || "unknown"}`)),
    ad_filter_reason: adSourceFiltered ? "talker-policy-category-advertising" : null,
    attachment_failure_class: result.ok ? null : "attachment_unresolved",
    attachment_failure_reason: result.ok ? null : (result.reason || "unknown"),
    attachment_retry_attempts: Number(existingVideo?.attachment_retry_attempts || 0),
    attachment_stage: result.ok ? "materialized" : kind === "file" ? "attachment-resolve" : "media-resolve",
    cdn_fileid: result.cdn_fileid || null,
    cdn_aeskey: result.cdn_aeskey || null,
    cdn_ready: result.cdn_ready || false,
    source: "pc-hook",
  };

  if (result.ok) {
    manifest.file = result.file;
    manifest.path_hint = result.file;
    manifest.status = "pending";
    event.media_path = result.file;
    event.media_status = "ready";
    event.media_method = result.method || "plain_copy";
    event.media_hd_pending = false;
    event.media_middle_pending = !!result.middle_pending;
    event.media_captured_tier = result.captured_tier || null;
    if (result.middle_pending) event.media_note = "prescreen_ready; native_middle_pending";
  } else {
    event.media_status = result.reason || "failed";
    // Keep resolver context so cache races are not misreported as a generic
    // vision failure downstream.
    event.media_error = JSON.stringify({
      stage: kind === "file" ? "attachment-resolve" : "media-resolve",
      format: kind,
      reason: result.reason || "unknown",
      resolver_error: result.resolver_error || null,
      resource_count: Array.isArray(resources) ? resources.length : 0,
      candidate_names: Array.isArray(result.names) ? result.names.slice(0, 20) : [],
    });
    manifest.media_error = event.media_error;
    if (result.path_hint) event.media_path = result.path_hint;
  }

  appendManifest(manifest);
  event.media_message_key = messageKey;
  event.media_message_ts_ms = tsMs || Date.now();
  event.media_create_time = messageCreateTime;
  event.media_local_id = localId;
  event.media_server_id = serverId;
  event.media_first_seen_at_ms = firstSeenAtMs;
  event.media_file_sha256 = result.file_sha || null;
  event.media_image_hash = result.image_hash || null;
  event.media_thumbnail_sha256 = result.captured_tier === "thumbnail" ? result.file_sha || null : null;
  event.media_middle_sha256 = result.captured_tier === "middle" ? result.file_sha || null : null;
  event.media_full_sha256 = null;
  event.media_thumbnail_first_seen_at_ms = event.media_thumbnail_sha256 ? firstSeenAtMs : null;
  event.media_full_first_seen_at_ms = null;
  if (result.ok && !videoReplayBlocked) triggerDistill(messageKey, result.file_sha || "");
  return event;
}

function loadManifestRows() {
  if (!fs.existsSync(MANIFEST_PATH)) return [];
  return fs
    .readFileSync(MANIFEST_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

let lastHdRetryAt = 0;
const fileRetryState = new Map();
// Retrying unresolved images can query hardlink.db.  This runs in the same
// client process context as the bridge's Hook calls, so favor a conservative
// cadence over repeatedly probing a file that Weixin has not committed yet.
const HD_RETRY_COOLDOWN_MS = Number(process.env.WECHAT_HD_RETRY_COOLDOWN_MS || "120000");
const HD_RETRY_MAX_AGE_MS = Number(
  process.env.WECHAT_HD_RETRY_MAX_AGE_MS || String(30 * 60 * 1000),
);
const FILE_RETRY_MAX_AGE_MS = Number(
  process.env.WECHAT_FILE_RETRY_MAX_AGE_MS || String(14 * 24 * 60 * 60 * 1000),
);
const FILE_RECONCILE_BATCH_LIMIT = Number(process.env.WECHAT_FILE_RECONCILE_BATCH_LIMIT || "12");
const FILE_RECONCILE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xlsx", ".xls", ".ppt", ".pptx", ".csv", ".txt", ".zip", ".rar",
]);
const OFFICE_OWNER_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

function safeAttachmentInboxName(fileName, fileSha) {
  const safe = String(fileName || "attachment")
    .replace(/[^\w\u4e00-\u9fff.\-()+]/g, "_")
    .slice(-160);
  return `pc_reconcile_${fileSha.slice(0, 12)}_${safe || "attachment"}`;
}


function normalizedAttachmentName(name) {
  return String(name || "")
    .normalize("NFKC")
    .replace(/[\\/]+/g, "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/[\s_\-()（）【】\[\]]+/g, "");
}

function latestManifestRows(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const key = row.id || row.message_key || [row.talker, row.local_id, row.ts].join("|");
    out.set(key, row);
  }
  return [...out.values()];
}

function bindCapturedFileToMessage(captured, messageRows, now) {
  const capturedName = normalizedAttachmentName(captured.file_name || path.basename(captured.source_path || ""));
  const capturedTs = Number(captured.ts || captured.message_ts_ms || 0);
  const candidates = [];
  for (const row of messageRows) {
    if (row.source !== "pc-hook" || row.kind !== "file") continue;
    if (!row.talker || Number(row.local_id || 0) <= 0) continue;
    if (row.status === "pending" && row.file && fs.existsSync(row.file)) continue;
    const rowTs = Number(row.ts || row.message_ts_ms || 0);
    const deltaMs = capturedTs && rowTs ? Math.abs(capturedTs - rowTs) : Number.POSITIVE_INFINITY;
    if (deltaMs > 120000) continue;
    const rowName = normalizedAttachmentName(row.file_name || row.original_file_name || "");
    candidates.push({ row, deltaMs, nameMatch: Boolean(capturedName && rowName && capturedName === rowName) });
  }
  if (!candidates.length) return null;
  const named = candidates.filter((item) => item.nameMatch);
  const pool = named.length === 1 ? named : named.length > 1 ? named : candidates;
  pool.sort((a, b) => a.deltaMs - b.deltaMs || String(a.row.message_key || a.row.id).localeCompare(String(b.row.message_key || b.row.id)));
  const best = pool[0];
  const runner = pool[1];
  const unique = !runner || runner.deltaMs - best.deltaMs >= 5000;
  if (!unique || (!best.nameMatch && best.deltaMs > 45000)) return null;
  return {
    ...best.row,
    status: "pending",
    attachment_stage: "materialized",
    message_binding_required: false,
    file: captured.file,
    path_hint: captured.file,
    canonical_file: captured.canonical_file || captured.file,
    file_sha: captured.file_sha,
    file_name: captured.file_name,
    media_method: "wechat-file-cache-reconciled",
    recovered_at: new Date(now).toISOString(),
    binding_basis: {
      method: best.nameMatch ? "normalized_filename_and_time" : "unique_time_correlation",
      delta_ms: best.deltaMs,
      captured_id: captured.id,
      captured_source: captured.source_path,
    },
  };
}

async function reconcileUnindexedWechatFiles(cfg, latestRows, now) {
  const root = await getFilesRoot(cfg);
  const wxid = cfg.wechat_account_wxid || cfg.self_wxid || cfg.pc_login_wxid || "";
  const accountDir = findAccountDir(root, wxid);
  const fileRoot = accountDir && path.join(accountDir, "msg", "file");
  if (!fileRoot || !fs.existsSync(fileRoot)) return [];

  // This is intentionally a *capture* fallback, not a message association
  // shortcut. We only scan WeChat's controlled msg/file store, retain the
  // original file under inbox/by_sha, and mark it unbound. Nothing downstream
  // may treat it as a calendar source until a message/database record binds it.
  const rows = latestManifestRows(latestRows);
  const knownSha = new Set(rows.map((row) => row.file_sha).filter(Boolean));
  const bound = [];
  for (const captured of rows.filter((row) => row.source === "pc-file-reconcile" && row.status === "captured_unbound")) {
    const binding = bindCapturedFileToMessage(captured, rows, now);
    if (!binding) continue;
    appendManifest(binding);
    appendManifest({
      ...captured,
      status: "bound",
      attachment_stage: "bound_to_message",
      message_binding_required: false,
      bound_message_key: binding.message_key || binding.id,
      bound_at: new Date(now).toISOString(),
      binding_basis: binding.binding_basis,
    });
    bound.push(binding);
    console.log("[wechat-bridge] reconciled file binding talker=" + binding.talker + " local=" + binding.local_id + " name=" + binding.file_name);
  }
  const candidates = [];
  for (const monthDir of fs.readdirSync(fileRoot)) {
    const monthPath = path.join(fileRoot, monthDir);
    let entries = [];
    try {
      entries = fs.readdirSync(monthPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!FILE_RECONCILE_EXTENSIONS.has(ext)) continue;
      // Office owner/lock files retain the document extension, but contain
      // owner metadata rather than document bytes. Reject before copying or
      // registering; existing failure records and attempt budgets stay intact.
      if (entry.name.startsWith("~$") && OFFICE_OWNER_EXTENSIONS.has(ext)) continue;
      const source = path.join(monthPath, entry.name);
      try {
        const stat = fs.statSync(source);
        if (!stat.size || now - stat.mtimeMs > FILE_RETRY_MAX_AGE_MS) continue;
        candidates.push({ source, fileName: entry.name, mtimeMs: stat.mtimeMs, bytes: stat.size });
      } catch {
        // File may be moving while WeChat commits it.
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.fileName.localeCompare(b.fileName));
  const captured = [];
  for (const candidate of candidates.slice(0, FILE_RECONCILE_BATCH_LIMIT)) {
    const canon = canonicalizeAttachmentFile(candidate.source);
    if (knownSha.has(canon.file_sha)) continue;
    fs.mkdirSync(MEDIA_INBOX, { recursive: true });
    const inbox = path.join(MEDIA_INBOX, safeAttachmentInboxName(candidate.fileName, canon.file_sha));
    if (!fs.existsSync(inbox)) fs.copyFileSync(candidate.source, inbox);
    const row = {
      id: `pc-file-reconcile|${canon.file_sha}`,
      message_key: `pc-file-reconcile|${canon.file_sha}`,
      kind: "file",
      status: "captured_unbound",
      attachment_stage: "awaiting_message_binding",
      message_binding_required: true,
      source: "pc-file-reconcile",
      source_path: candidate.source,
      file: canon.file,
      path_hint: canon.file,
      canonical_file: canon.canonical_file,
      file_sha: canon.file_sha,
      file_name: candidate.fileName,
      capture_bytes: candidate.bytes,
      ts: candidate.mtimeMs,
      message_ts_ms: candidate.mtimeMs,
      first_seen_at_ms: now,
      registered_at: new Date(now).toISOString(),
    };
    appendManifest(row);
    knownSha.add(canon.file_sha);
    captured.push(row);
    console.log(`[wechat-bridge] unbound file captured name=${candidate.fileName}`);
  }
  return [...bound, ...captured];
}

// The two active lookups may finish before the desktop cache receives the clip.
const lateVideoMisses = new Map();

function lateVideoSource(row) {
  if (row.kind !== "video" || row.attachment_failure_reason !== "video-cache-not-found" ||
      row.status !== "pending" || row.file || row.file_sha || !row.original_content ||
      !row.message_create_time || !row.server_id || row.server_id === "0") return null;
  const source = {local_type:43, local_id:row.local_id, server_id:row.server_id,
    create_time:row.message_create_time, message_content:row.original_content};
  return buildMediaMessageKey(row.talker, source) === row.message_key ? source : null;
}

// An MP4 may appear in a different month or grow in place. Only repeat a
// missed local lookup when the inventory changes (or the process restarts).
function videoCacheVersion(accountDir) {
  const root = path.join(accountDir, "msg", "video");
  const files = [];
  try {
    for (const month of fs.readdirSync(root, {withFileTypes:true})) {
      if (!month.isDirectory()) continue;
      const folder = path.join(root, month.name);
      for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
        if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
        const stat = fs.statSync(path.join(folder, entry.name), {bigint:true});
        files.push(JSON.stringify([month.name, entry.name, String(stat.ino), String(stat.size),
          String(stat.mtimeNs), String(stat.ctimeNs)]));
      }
    }
  } catch { return null; } // The cache can move during enumeration.
  return crypto.createHash("sha256").update(JSON.stringify([accountDir, files.sort()])).digest("hex");
}

async function retryMissingFileManifest(cfg, latestRows, now) {
  const recovered = [];
  const unresolved = [...latestRows].filter(row => row.source === "pc-hook" &&
    ["file", "video"].includes(row.kind) && row.talker && Number(row.local_id) > 0 &&
    now >= Number(row.ts) && now - Number(row.ts) <= FILE_RETRY_MAX_AGE_MS);
  const candidates = unresolved.filter(row => Number(row.attachment_retry_attempts || 0) < 2 &&
    (!row.file || !fs.existsSync(row.file) || row.status === "missing" ||
     row.attachment_failure_class === "attachment_unresolved" || row.vision_state === "waiting_media" ||
     (row.kind === "video" && row.file && row.file_sha && !row.media_method &&
      row.status === "pending" && row.vision_state === "retry")))
    .sort((a, b) => b.ts - a.ts).slice(0, FILE_RECONCILE_BATCH_LIMIT);
  const late = unresolved.filter(row => Number(row.attachment_retry_attempts) >= 2 && lateVideoSource(row));
  const pendingKeys = new Set(late.map(row => row.message_key));
  for (const key of lateVideoMisses.keys()) if (!pendingKeys.has(key)) lateVideoMisses.delete(key);
  if (!candidates.length && !late.length) return recovered;

  const root = await getFilesRoot(cfg);
  const wxid = cfg.wechat_account_wxid || cfg.self_wxid || cfg.pc_login_wxid || "";
  const accountDir = findAccountDir(root, wxid);
  if (!accountDir) return recovered;
  const version = late.length ? videoCacheVersion(accountDir) : null;
  if (version) {
    candidates.push(...late.filter(row => lateVideoMisses.get(row.message_key) !== version)
      .slice(0, FILE_RECONCILE_BATCH_LIMIT));
  }

  for (const row of candidates) {
    const key = row.id || row.message_key || `${row.talker}|${row.local_id}|${row.ts}`;
    const retry = fileRetryState.get(key) || { attempts: Number(row.attachment_retry_attempts || 0), nextAt: 0 };
    const passiveSource = Number(row.attachment_retry_attempts) >= 2 ? lateVideoSource(row) : null;
    if (!passiveSource && (now < retry.nextAt || retry.attempts >= 2)) continue;
    let resources = [];
    let result;
    try {
      resources = row.kind === "video" ? [] : await fetchMessageResources(cfg, row.talker, Number(row.local_id));
      const msgRow = passiveSource || await fetchExactMessageRow(cfg, row);
      const {baseType} = decodeMessageType(msgRow.local_type);
      const exactMetadata = baseType === 49 ? attachmentMetadata(msgRow.message_content) : {};
      if (row.kind === "video" && mediaKind(msgRow.local_type) === "video") {
        result = await materializeVideo(cfg, accountDir, row.talker, msgRow);
      } else if (row.kind === "video" || (mediaKind(msgRow.local_type) !== "file" && !(baseType === 49 && exactMetadata.file_name))) {
        result = {ok:false, reason:"source-type-mismatch:" + msgRow.local_type};
      } else {
        result = await materializeFile(cfg, accountDir, row.talker, msgRow, resources);
      }
    } catch (err) {
      if (/message-database-(?:unavailable|discovery-unavailable)|get database handle|ECONNREFUSED|hook timeout|EIO|input.output error/i.test(err?.message || "")) {
        fileRetryState.set(key, { ...retry, nextAt: now + 60000 });
        break;
      }
      result = { ok: false, reason: `resolver-exception:${err?.message || String(err)}` };
    }
    if (passiveSource && !result?.ok) {
      if (result?.reason === "video-cache-not-found") lateVideoMisses.set(row.message_key, version);
      continue;
    }
    if (!result?.ok) {
      const attempts = retry.attempts + 1;
      const reason = String(result?.reason || "file_not_found");
      const terminal = attempts >= 2;
      const failedRow = {
        ...row,
        status: "pending",
        vision_state: terminal ? "attachment_resolve_failed" : "waiting_media",
        vision_last_error: `attachment-unresolved:${reason}`,
        media_error: `attachment-unresolved:${reason}`,
        attachment_failure_class: "attachment_unresolved",
        attachment_failure_reason: reason,
        attachment_retry_attempts: attempts,
        vision_next_retry_at: terminal ? null : new Date(now + 15000 * 2 ** (attempts - 1)).toISOString(),
        updated_at: new Date(now).toISOString(),
      };
      appendManifest(failedRow);
      fileRetryState.set(key, { attempts, nextAt: terminal ? Infinity : now + 15000 * 2 ** (attempts - 1) });
      console.warn(`[wechat-bridge] file resolve ${terminal ? "retry-exhausted" : "retry"} talker=${row.talker} local=${row.local_id} reason=${reason}`);
      continue;
    }
    fileRetryState.delete(key);
    const videoReplayBlocked = row.kind === "video" && (Number(row.vision_attempts || 0) >= 2 ||
      !!row.backlog_api_job || row.completion_validation_failure?.automatic_replay_blocked === true);
    const recoveredRow = {
      ...row,
      status: "pending",
      vision_state: videoReplayBlocked ? "repair_required" : "retry",
      vision_last_error: videoReplayBlocked ? row.vision_last_error : null,
      media_error: null,
      attachment_failure_class: null,
      attachment_failure_reason: null,
      attachment_retry_attempts: row.kind === "video" ? Number(row.attachment_retry_attempts || 0) : 0,
      vision_next_retry_at: null,
      file: result.file,
      path_hint: result.file,
      canonical_file: result.canonical_file,
      file_sha: result.file_sha,
      file_name: result.file_name,
      media_method: result.method,
      attachment_byte_evidence: result.attachment_byte_evidence || row.attachment_byte_evidence,
      recovered_at: new Date().toISOString(),
    };
    appendManifest(recoveredRow);
    recovered.push(recoveredRow);
    if (!videoReplayBlocked) triggerDistill(row.message_key || row.id || "", result.file_sha || "");
    console.log(`[wechat-bridge] file recovered talker=${row.talker} local=${row.local_id} name=${result.file_name}`);
  }
  return recovered;
}

async function tryCdnDownloadImage(cfg, row, imageHash = "") {
  const fileid = row.cdn_fileid;
  const aeskey = row.cdn_aeskey;
  if (!fileid || !aeskey) return null;
  fs.mkdirSync(MEDIA_INBOX, { recursive: true });
  const base = `pc_cdn_${talkerHash(row.talker || "x")}_${String(imageHash || row.image_hash || "img").slice(0, 8)}`;
  const cdnOut = path.join(MEDIA_INBOX, `${base}.jpg`);
  try {
    const minBytes = Number(row.expected_full_bytes || row.hdlength || 0);
    const cdn = await downloadViaCdn(
      cfg,
      { aeskey, fileid, chatType: 0, largesVideo: 0, fileType: 2 },
      cdnOut,
      minBytes,
    );
    const size = fs.existsSync(cdnOut) ? fs.statSync(cdnOut).size : 0;
    if (
      cdn?.ret === 0 &&
      cdnImageFileAcceptable(cdnOut, minBytes) &&
      fs.existsSync(cdnOut) &&
      isRasterImageFile(cdnOut)
    ) {
      const canon = canonicalizeImageFile(cdnOut);
      return finalizeImageResult(
        {
          ok: true,
          kind: "image",
          file: canon.file,
          canonical_file: canon.canonical_file,
          file_sha: canon.file_sha,
          method: "hook-cdn-download",
          image_hash: imageHash || row.image_hash || null,
          decode_bytes: size,
          cdn_fileid: fileid,
          cdn_aeskey: aeskey,
          cdn_ready: true,
        },
        {
          fileid,
          aeskey,
          length: Number(row.middle_expected_bytes || 0),
          hdlength: minBytes,
        },
        { full: minBytes },
      );
    }
  } catch {
    // /download not implemented in hook yet (404)
  }
  return null;
}


let passiveImageScanCursor = 0;
let importantImageScanCursor = 0;
let imageRetryRunning = false;
let fileRecoveryRunning = false;
let lastImageRetryAt = 0;
const IMAGE_CHECK_STATE = path.join(WORKSPACE_WECHAT, "state", "image-source-checks.json");

function readImageDemands() {
  const out = [];
  const dir = path.join(WORKSPACE_WECHAT, "state", "image-demands");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); } catch {}
    }
  } catch {}
  return out;
}

// A postprocess job can outlive the manifest row that originally carried its
// media metadata (for example after a manifest compaction or a resolver race).
// Keep source acquisition durable by reconstructing a read-only image row from
// the job event. This never changes the job or grants another processor run;
// it only lets the existing bounded native-middle check see the exact message
// identity and thumbnail bytes again.
function loadDurableRetryImageRows() {
  try {
    const parsed = JSON.parse(fs.readFileSync(POSTPROCESS_JOBS_PATH, "utf8"));
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return jobs
      .filter(job => {
        const event = job?.event || {};
        return ["retry", "queued"].includes(String(job?.status || "")) &&
          ["image-tier-not-ready", "no-image-file", "waiting-native-middle-cache"].includes(String(job?.last_error || "")) &&
          event.media_kind === "image" &&
          (event.media_status === "waiting_native_middle_cache" ||
           (event.media_middle_pending === true &&
            /^[a-f0-9]{64}$/i.test(String(event.media_file_sha256 || ""))));
      })
      .map(job => {
        const event = job.event || {};
        const messageKey = event.media_message_key || event.message_key ||
          buildMediaMessageKey(event.talker, {
            local_id: event.media_local_id ?? event.local_id,
            create_time: event.media_create_time ?? Math.floor(Number(event.ts || 0) / 1000),
            server_id: event.media_server_id ?? event.msg_svr_id,
          });
        const fileSha = String(event.media_file_sha256 || "").toLowerCase();
        return {
          id: messageKey,
          message_key: messageKey,
          talker: event.talker || "",
          ts: Number(event.ts || 0),
          message_ts_ms: Number(event.media_message_ts_ms || event.ts || 0),
          message_create_time: Number(event.media_create_time || Math.floor(Number(event.ts || 0) / 1000)),
          local_id: Number(event.media_local_id ?? event.local_id ?? 0),
          server_id: String(event.media_server_id ?? event.msg_svr_id ?? ""),
          kind: "image",
          source: "pc-hook",
          status: "pending",
          vision_state: "waiting_source",
          file: event.media_path || "",
          canonical_file: event.media_path || "",
          path_hint: event.media_path || "",
          file_sha: fileSha,
          thumbnail_sha256: String(event.media_thumbnail_sha256 || fileSha).toLowerCase(),
          captured_tier: event.media_captured_tier || (fileSha ? "thumbnail" : null),
          middle_pending: true,
          image_hash: event.media_image_hash || "",
          // A waiting job is a candidate for source reconciliation. Its
          // retry marker alone never authorizes a download or recognition.
          durable_retry_source: true,
          retry_attempts: Number(job.attempts || 0),
        };
      })
      .filter(row => row.talker && row.local_id > 0 && row.server_id && row.message_key)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  } catch {
    return [];
  }
}

function mergeDurableRetryImageRows(latestByMessage) {
  for (const row of loadDurableRetryImageRows()) {
    const key = row.message_key || row.id;
    const current = latestByMessage.get(key);
    if (!current) {
      latestByMessage.set(key, row);
      continue;
    }
    // Fill only missing source identity fields. Manifest provenance remains
    // authoritative when it already contains a value.
    latestByMessage.set(key, {
      ...row,
      ...current,
      image_hash: current.image_hash || row.image_hash,
      file_sha: current.file_sha || row.file_sha,
      thumbnail_sha256: current.thumbnail_sha256 || row.thumbnail_sha256,
      middle_pending: current.middle_pending ?? row.middle_pending,
      durable_retry_source: current.durable_retry_source || row.durable_retry_source,
    });
  }
}

function imageIsRequested(row, demands) {
  const key = row.message_key || row.id;
  const shas = [row.file_sha, row.thumbnail_sha256, row.middle_sha256, row.full_sha256].filter(Boolean);
  return demands.some(d => (key && d.message_key === key) ||
    (d.file_sha && shas.includes(d.file_sha) && (!d.talker || d.talker === row.talker)));
}

function imageNeedsSourceWork(row, demands) {
  // Source acquisition ends at middle, including explicitly requested images.
  // A question can reuse/review those bytes without reopening acquisition.
  const local = row.canonical_file || row.file;
  if (effectiveCapturedTier(row) === "middle" && local && fs.existsSync(local)) return false;
  if (row.source_recall?.kind === "wechat-revokemsg") return false;
  if (imageIsRequested(row, demands)) return true;
  // A postprocess job can fail after its coarse thumbnail screening has been
  // persisted as a completed manifest row.  The durable retry marker is the
  // exact evidence that the original business task is still waiting for a
  // distinct native middle source; do not let the coarse completion gate hide
  // that source request.
  if (row.durable_retry_source === true && row.middle_pending === true) return true;
  // An explicit middle wait remains source work even when coarse screening
  // already marked the business row done. The downstream contract requires
  // a real middle file before this wait can be cleared.
  if (row.middle_pending === true && effectiveCapturedTier(row) === 'thumbnail') return true;
  // A completed prescreen is sufficient. Better cache bytes alone are not a
  // new task and must not cause another decode, inference, or business replay.
  if (row.status === "filtered" || row.filtered_low_value) return false;
  if (row.status === "done" && row.screening_relevance === "irrelevant" &&
      row.screening_decision === "summary_complete" && row.summary &&
      Number(row.summary_confidence || 0) >= 0.6 &&
      Array.isArray(row.summary_evidence) && row.summary_evidence.length > 0 &&
      ["gemini", "antigravity-subscription"].includes(row.summary_provider) &&
      /flash/i.test(row.summary_model || "") && !/pro|argon|auto/i.test(row.summary_model || "") &&
      !row.vision_last_error && row.vision_state === "done") return false;
  if (row.status === "done" && row.summary && Number(row.summary_confidence || 0) >= 0.78 &&
      !row.vision_last_error && !["retry", "waiting_source", "waiting_media"].includes(row.vision_state)) return false;
  return true;
}

function selectPassiveImageCandidates(rows, limit = Number(process.env.WECHAT_PASSIVE_IMAGE_SCAN_LIMIT || 64), demands = []) {
  const eligible = [...rows].filter(row => row.source === "pc-hook" && row.kind === "image" && row.talker && (row.image_hash || row.cdn_middle_fileid ||
      (!row.file_sha && row.middle_pending && row.server_id && row.local_id && row.message_key)) &&
    imageNeedsSourceWork(row, demands) &&
    (!["filtered", "discarded"].includes(row.status) ||
      (row.middle_pending === true && effectiveCapturedTier(row) === 'thumbnail') ||
      (imageIsRequested(row, demands) && (row.status === "filtered" || row.vision_last_error === "aged-out-no-media"))));
  if (!eligible.length) return [];
  const budget = Math.min(eligible.length, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 64));
  const important = eligible.filter(row => imageIsRequested(row, demands));
  const picked = [];
  // Important requests get a reserved share; ordinary images still rotate.
  const urgentBudget = Math.min(important.length, budget === 1 ? 0 : Math.max(1, Math.floor(budget / 2)));
  for (let i = 0; i < urgentBudget; i++) picked.push(important[(importantImageScanCursor + i) % important.length]);
  if (important.length) importantImageScanCursor = (importantImageScanCursor + urgentBudget) % important.length;
  // Manifest order includes durable retry rows and late source updates, so
  // its final row is not necessarily the newest message. Reserve one slot
  // for the newest unresolved image to wake native middle acquisition before
  // downstream media-wait attempts are exhausted.
  const durable = eligible.find(row => row.durable_retry_source === true);
  if (budget > 1 && durable && !picked.includes(durable) && picked.length < budget) picked.push(durable);
  const newest = eligible.reduce((latest, row) =>
    Number(row.ts || 0) > Number(latest?.ts || 0) ? row : latest, null);
  if (budget > 1 && newest && !picked.includes(newest) && picked.length < budget) picked.push(newest);
  for (let i = 0; i < eligible.length && picked.length < budget; i++) {
    const row = eligible[passiveImageScanCursor % eligible.length];
    passiveImageScanCursor = (passiveImageScanCursor + 1) % eligible.length;
    if (!picked.includes(row)) picked.push(row);
  }
  return picked;
}

function readSourceChecks() {
  try { return JSON.parse(fs.readFileSync(IMAGE_CHECK_STATE, "utf8")); } catch { return {}; }
}

function saveSourceChecks(checks) {
  fs.mkdirSync(path.dirname(IMAGE_CHECK_STATE), { recursive: true });
  const temp = `${IMAGE_CHECK_STATE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(checks));
  fs.renameSync(temp, IMAGE_CHECK_STATE);
}

function imageSourceCheckReady(check, signature, now) {
  if (check.signature !== signature) return false;
  // The budget belongs to unchanged source bytes and survives bridge restarts.
  return !(check.done && check.middle_metadata_version === 3) &&
    Number(check.attempts || 0) < 2 && now >= Number(check.next_at || 0);
}

function decodeViaPythonAsync(src, dst) {
  return new Promise(resolve => {
    execFile("python3", [DECRYPT_SCRIPT, "--in", src, "--out", dst, "--json"],
      { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        try { resolve(JSON.parse(String(stdout).trim())); }
        catch { resolve({ ok: false, error: err ? "decode-failed" : "invalid-decode-output" }); }
      });
  });
}

// A recall replaces the original row in place. Require the full, unrounded
// identity and the structured system notice, never a type change alone.
function imageRecallReceipt(row, current) {
  if (Number(current?.local_type) !== 10000 || typeof row.server_id !== "string" ||
      !/^[1-9][0-9]*$/.test(row.server_id) || current.server_id !== row.server_id ||
      buildMediaMessageKey(row.talker, current) !== row.message_key ||
      Number(current.local_id) !== Number(row.local_id) ||
      Number(current.create_time) !== Number(row.message_create_time)) return null;
  const xml = decompressMsgContentHex(current.message_content) || current.message_content || "";
  if (!/<sysmsg\s+type=["']revokemsg["']\s*>\s*<revokemsg>/i.test(xml)) return null;
  return {kind:"wechat-revokemsg", message_key:row.message_key, source_db:current.message_db};
}

// DrvFS may not forward Windows write notifications to inotify. Watch only
// the exact pending paths by stat. The normal scan remains the restart path.
const middleWatches = new Map();
function watchMiddleArrival(key, sources, wake) {
  if (!wake || middleWatches.has(key) || middleWatches.size >= 32) return;
  const paths = [...new Set(sources.filter(Boolean))];
  if (!paths.length) return;
  let settling;
  let generation = 0;
  function stop() {
    generation++;
    for (const file of paths) fs.unwatchFile(file, changed);
    clearTimeout(deadline);
    clearTimeout(settling);
    middleWatches.delete(key);
  }
  async function changed(stat) {
    if (!stat.isFile() || stat.size < 32) return;
    const observed = ++generation;
    clearTimeout(settling);
    try {
      await wake(key);
    } catch (err) {
      console.warn("[wechat-bridge] source wake:", err.message);
    }
    if (observed !== generation) return;
    // Start the stability interval after the first scan actually finishes.
    settling = setTimeout(() => Promise.resolve(wake(key)).catch(err =>
      console.warn("[wechat-bridge] stable source wake:", err.message)), 1500);
    settling.unref?.();
  }
  const deadline = setTimeout(stop, 120000);
  deadline.unref?.();
  middleWatches.set(key, stop);
  for (const file of paths) fs.watchFile(file, {persistent:false, interval:500}, changed);
  // A rename may have completed between the scan and listener registration.
  for (const file of paths) {
    const stat = fs.statSync(file, {throwIfNoEntry:false});
    if (stat?.isFile() && stat.size >= 32) { void changed(stat); break; }
  }
}

function shouldResolveMiddle(row, requested) {
  if (requested) return true;
  if (!/^[a-f0-9]{64}$/.test(row.file_sha || "")) return false;
  const spam = row.content_pool === "spam" || resolveTalkerPolicy(row.talker).content_pool === "spam";
  if (spam || row.filtered_low_value || ["filtered", "discarded"].includes(row.status)) return false;
  // A finished non-ad screen can retain the middle path for later questions
  // without sending the image through recognition again.
  if (hasCompletedThumbnailScreen(row)) return true;
  try {
    const key = crypto.createHash("sha256").update(row.file_sha).digest("hex");
    const budget = JSON.parse(fs.readFileSync(path.join(WORKSPACE_WECHAT,
      "state/image-inference-budget", key + ".json"), "utf8"));
    return budget.waiting_source === true && budget.last_error === "image-tier-not-ready" &&
      needsNativeMiddle(row, {coarse: budget.coarse_screening || {}});
  } catch { return false; }
}

function hasCompletedThumbnailScreen(row) {
  return row.status === "done" && row.vision_state === "done" && !row.vision_last_error &&
    row.screening_decision === "summary_complete" && row.summary && row.middle_pending === true &&
    effectiveCapturedTier(row) === "thumbnail" &&
    Array.isArray(row.summary_evidence) && row.summary_evidence.length > 0 &&
    ["gemini", "gemini-api", "antigravity-subscription"].includes(row.summary_provider) &&
    /flash/i.test(row.summary_model || "");
}

async function retryImageSources(cfg, latestByMessage, now, force, onMiddleArrival) {
  if (imageRetryRunning || (!force && now - lastImageRetryAt < 9000)) return [];
  imageRetryRunning = true;
  lastImageRetryAt = now;
  try {
    const root = await getFilesRoot(cfg);
    const wxid = cfg.wechat_account_wxid || cfg.self_wxid || cfg.pc_login_wxid || "";
    const accountDir = findAccountDir(root, wxid);
    if (!accountDir) return [];
    const demands = readImageDemands();
    const checks = readSourceChecks();
    let missingLookupBudget = 2;
    const candidates = selectPassiveImageCandidates(latestByMessage.values(), undefined, demands);
    const ready = [];
    const upgraded = [];
    // One bounded native call per existing source pass; no new timer/queue.
    // Explicit requests first, then recent messages; old downloads cannot
    // monopolize the native worker or block bridge message polling.
    let nativeBudget = Math.max(1, Number(process.env.WECHAT_NATIVE_MIDDLE_BUDGET || 16));
    candidates.sort((a,b) => Number(imageIsRequested(b, demands)) - Number(imageIsRequested(a, demands)) ||
      Number(b.ts || 0) - Number(a.ts || 0));
    for (const row of candidates) {
      const identity = row.message_key || row.id;
      const important = imageIsRequested(row, demands);
      if (important) checks[`scan:${identity}`] = { checked_at: now, tier: row.captured_tier || "unknown" };
      const month = monthDirFromTs(Math.floor(Number(row.ts || 0) / 1000));
      const paths = resolveImageAttachPaths(accountDir, row.talker, row.image_hash, month, [], true);
      const ct = Number(row.message_create_time || Math.floor(Number(row.ts || 0) / 1000));
      // Initial capture can precede both thumbnail bytes and a sender's recall.
      // Refresh from the same message before spending any recognition budget.
      if (!row.file_sha && missingLookupBudget > 0 && row.middle_pending &&
          now >= Number(checks["absent:" + identity]?.next_at || 0)) {
        missingLookupBudget--;
        checks["absent:" + identity] = {next_at: now + 60000};
        try {
          const current = await fetchExactMessageRow(cfg, {...row, kind:undefined});
          const recall = imageRecallReceipt(row, current);
          if (recall) {
            appendManifest({...row, status:"withdrawn", vision_state:"withdrawn",
              source_recall:recall, middle_pending:false});
            continue;
          }
          if (Number(current.local_type) === IMAGE_TYPE &&
              buildMediaMessageKey(row.talker, current) === identity) {
            const result = await materializeImage(cfg, accountDir, row.talker, current,
              await fetchMessageResources(cfg, row.talker, row.local_id));
            if (result.ok) {
              const fresh = stampImageFileIdentity({...row, ...result, status:"pending",
                vision_state:"retry", attachment_stage:"materialized", attachment_failure_reason:null,
                attachment_failure_class:null, media_error:null, vision_last_error:null});
              appendManifest(fresh);
              if (Number(row.vision_attempts || 0) < 2) triggerDistill(identity, fresh.file_sha);
              upgraded.push(fresh);
              continue;
            }
          }
        } catch (err) {
          console.warn("[wechat-bridge] missing image lookup:", err.code || err.name);
        }
      }
      const waitingForMiddle = row.middle_pending === true &&
        effectiveCapturedTier(row) === 'thumbnail';
      const sources = [paths?.extraWsl,
        ...["mid_temp_convert", "mid_temp"].map(suffix =>
          resolveImageCacheTempPath(accountDir, row.talker, row.local_id, ct, suffix)?.wsl),
        row.cdn_middle_fileid ? hookAutoInboxPath(row.cdn_middle_fileid).replace(/\.jpg$/, ".middle.jpg") : null];
      // Previously observed paths are safe only when their basename is exact.
      for (const hint of [row.source_dat, row.passive_upgrade_source_path]) {
        if (hint && path.basename(hint) === row.image_hash + ".dat") sources.push(hint);
      }
      const wantsMiddle = shouldResolveMiddle(row, important);
      // A pre-existing file is subject to the same screening decision as a
      // later file notification. Never run a second read for an ad.
      if (waitingForMiddle && !wantsMiddle) continue;
      if (wantsMiddle) watchMiddleArrival(identity, sources, onMiddleArrival);
      // Exact native middle cache and typed Hook middle copies only.
      if (important) checks[`request:${identity}`] = { state: "waiting-native-middle-cache", target_tier: "middle" };
      let sourcePresent = false;
      for (const src of new Set(sources.filter(Boolean))) {
        let stat;
        try { stat = await fs.promises.stat(src); } catch { continue; }
        if (!stat.isFile() || stat.size < 32) continue;
        // A pending-middle row can have only the thumbnail source. It proves
        // that bytes exist, but must not block the native middle request.
        const thumbnailOnly = waitingForMiddle && /_t\.dat$/i.test(path.basename(src));
        const expectedMiddle = Number(row.middle_expected_bytes || 0);
        const sourceTooSmall = waitingForMiddle && expectedMiddle > 0 &&
          stat.size < Math.floor(expectedMiddle * 0.8);
        const incompleteRaster = waitingForMiddle &&
          /\.(?:jpe?g|png)$/i.test(src) && !isCompleteRasterImage(src);
        if (thumbnailOnly || sourceTooSmall || incompleteRaster) continue;
        sourcePresent = true;
        const key = `${identity}|${src}`;
        const signature = `${stat.size}|${stat.mtimeMs}`;
        const check = checks[key] || {};
        // Observe a stable file on two passes before decoding a live download.
        if (check.signature !== signature) {
          checks[key] = { signature, observed_at: now, first_ready_at: now, next_at: now + 1000 };
          continue;
        }
        if (!imageSourceCheckReady(check, signature, now)) continue;
        ready.push({ row, src, stat, key, signature, important, check });
      }
      if (!sourcePresent && wantsMiddle && nativeBudget > 0) {
        let contactedNative = false;
        await requestNativeMiddle(row, {
          stateDir: path.join(WORKSPACE_WECHAT, 'state/native-middle-receipts'), now,
          request: body => {
            contactedNative = true;
            return hookRequest(cfg, '/TriggerDownload', body, {timeoutMs: 3500});
          },
        });
        if (contactedNative) nativeBudget -= 1;
        // A submit receipt is not source completion. The existing stable
        // bytes/decrypt/SHA/binding checks above must still pass next time.
      }
    }
    // Waiting changed sources are also fair: repeatedly arriving important
    // sources cannot permanently starve an already observed ordinary source.
    ready.sort((a,b) => Number(b.important) - Number(a.important) || a.check.first_ready_at - b.check.first_ready_at);
    // Decode at most one variant of a message per pass. Never append two
    // upgrades based on the same stale row snapshot.
    const unique = [];
    const identities = new Set();
    for (const item of ready) {
      const identity = item.row.message_key || item.row.id;
      if (identities.has(identity)) continue;
      identities.add(identity);
      unique.push(item);
    }
    const selected = unique.slice(0, 2);
    if (unique.length > 2 && selected.every(x => x.important)) {
      const ordinary = unique.filter(x => !x.important).sort((a,b) => a.check.first_ready_at - b.check.first_ready_at)[0];
      if (ordinary && now - ordinary.check.first_ready_at > 60000) selected[1] = ordinary;
    }
    for (const item of selected) {
      const { row, src, stat, key, signature, check } = item;
      const attempts = Number(check.attempts || 0) + 1;
      const fail = () => { checks[key] = { ...check, signature, attempts, next_at: now + Math.min(1800000, 30000 * 2 ** Math.min(attempts - 1, 6)) }; };
      const dst = path.join(MEDIA_INBOX, `pc_${talkerHash(row.talker)}_${row.local_id || 0}_${(row.image_hash || fileidInboxStem(row.cdn_middle_fileid)).slice(0,8)}_passive.jpg`);
      fs.mkdirSync(MEDIA_INBOX, { recursive: true });
      let decoded;
      if (/\.dat$/i.test(src) || !isRasterImageFile(src)) {
        decoded = await decodeViaPythonAsync(src, dst);
        if (!decoded?.ok || !fs.existsSync(decoded.out || dst)) { fail(); continue; }
      } else decoded = { ok: true, out: src };
      const after = await fs.promises.stat(src).catch(() => null);
      if (!after || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) { fail(); continue; }
      const out = decoded.out || dst;
      if (!isCompleteRasterImage(out)) { fail(); continue; }
      const canon = canonicalizeImageFile(out);
      const bytes = statSizeSafe(canon.file);
      const tier = classifyCapturedImageTier(
        { length: Number(row.middle_expected_bytes || 0), hdlength: Number(row.expected_full_bytes || row.hdlength || 0) },
        bytes, { imagePath: canon.file, sourcePath: src });
      const candidate = { ...row, file: canon.file, canonical_file: canon.canonical_file, file_sha: canon.file_sha,
        decode_bytes: bytes, captured_tier: "middle", hd_pending: false, hd_requested: false,
        target_tier: "middle", middle_pending: false, middle_sha256: canon.file_sha,
        middle_first_seen_at_ms: now, source_dat: src };
      const thumbnailSha = row.thumbnail_sha256 ||
        (["thumbnail", "thumb"].includes(effectiveCapturedTier(row)) ? row.file_sha : "");
      if (thumbnailSha && canon.file_sha.toLowerCase() === String(thumbnailSha).toLowerCase()) {
        // This unchanged source has been checked, not upgraded. Retain all
        // provenance and budgets; only new source bytes can be checked again.
        checks[key] = { ...check, signature, attempts, done: true,
          middle_metadata_version: 3, next_at: 0 }; continue;
      }
      if (!mediaRowIsBetter(candidate, row)) {
        checks[key] = { ...check, signature, attempts, done: true, middle_metadata_version: 3, next_at: 0 }; continue;
      }
      const oldImage = row.canonical_file || row.file;
      const similarity = rasterContentSimilarity(oldImage, canon.file);
      if (similarity !== null && similarity < 0.78) { fail(); continue; }
      // Recognition results belong to bytes; attempts and failure history
      // belong to the message and must survive source acquisition.
      const pathOnly = hasCompletedThumbnailScreen(row);
      if (pathOnly) candidate.summary_source_sha256 = row.summary_source_sha256 || row.file_sha;
      for (const field of Object.keys(candidate)) {
        if (!pathOnly && canon.file_sha !== row.file_sha &&
            !["vision_attempts", "vision_last_attempt_at", "vision_last_error"].includes(field) &&
            (/^(summary|vision_|schedule_ocr)/.test(field) || ["tags", "summarized_at"].includes(field))) candidate[field] = null;
      }
      const completedSameBytes = canon.file_sha === row.file_sha && row.status === "done" &&
        row.summary && Number(row.summary_confidence || 0) >= 0.78;
      const replayBlocked = Number(row.vision_attempts || 0) >= 2 ||
        row.vision_state === "repair_required" || !!row.backlog_api_job ||
        row.completion_validation_failure?.automatic_replay_blocked === true;
      if (!completedSameBytes && !pathOnly) Object.assign(candidate, { status: "pending",
        vision_state: replayBlocked ? "repair_required" : "retry",
        vision_next_retry_at: null });
      Object.assign(candidate, { optional_hd_upgrade: false,
        passive_upgrade_source_path: src, passive_upgrade_source_size: stat.size,
        passive_upgrade_source_mtime_ms: stat.mtimeMs, passive_upgrade_at: new Date(now).toISOString(),
        binding_basis: "exact_image_hash_or_fileid_new_file" });
      appendManifest(candidate);
      middleWatches.get(row.message_key || row.id)?.();
      const completedReliableSummary = row.status === "done" && row.summary &&
        Number(row.summary_confidence || 0) >= 0.78;
      if (!pathOnly && !completedSameBytes && !completedReliableSummary && !replayBlocked) {
        triggerDistill(row.message_key || row.id, canon.file_sha);
      }
      // Reliable completed work must not be replayed simply for an optional
      // source upgrade. Unresolved work keeps its existing durable queue.
      // Announce new source evidence even when inference has exhausted its
      // budget. Ingest independently verifies the exact source and the prior
      // pre-calendar failure before granting one recovery; this notification
      // itself never resets attempts or authorizes a calendar replay.
      if ((!pathOnly && !completedReliableSummary) || row.durable_retry_source) upgraded.push(candidate);
      checks[key] = { ...check, signature, attempts, done: true, middle_metadata_version: 3, next_at: 0 };
      console.log(`[wechat-bridge] exact image source upgraded local=${row.local_id} tier=${tier.tier} bytes=${bytes}`);
    }
    saveSourceChecks(checks);
    return upgraded;
  } finally { imageRetryRunning = false; }
}

async function retryHdPendingManifest(cfg, { force = false, passiveOnly = false, filesOnly = false, messageKey, onMiddleArrival } = {}) {
  const now = Date.now();
  const latestByMessage = new Map();
  for (const row of loadManifestRows()) latestByMessage.set(row.id || row.message_key || [row.talker,row.local_id,row.ts].join("|"), row);
  mergeDurableRetryImageRows(latestByMessage);
  const selected = messageKey ? new Map([...latestByMessage].filter(([,row]) =>
    (row.message_key || row.id) === messageKey)) : latestByMessage;
  const upgraded = filesOnly ? [] : await retryImageSources(cfg, selected, now, force, onMiddleArrival);
  if (passiveOnly || fileRecoveryRunning || (!force && now - lastHdRetryAt < HD_RETRY_COOLDOWN_MS)) return upgraded;
  fileRecoveryRunning = true;
  lastHdRetryAt = now;
  try {
    const recovered = await retryMissingFileManifest(cfg, latestByMessage.values(), now);
    const reconciled = await reconcileUnindexedWechatFiles(cfg, latestByMessage.values(), now);
    return [...upgraded, ...recovered, ...reconciled.filter(row => row.status === "pending")];
  } finally { fileRecoveryRunning = false; }
}

module.exports = {
  decodeMessageType,
  enrichAppCardEvent,
  enrichEventMedia,
  isMediaPayload,
  mediaPlaceholder,
  mediaKind,
  getFilesRoot,
  appendManifest,
  triggerDistill,
  retryHdPendingManifest,
  imageIsRequested,
  readImageDemands,
  selectPassiveImageCandidates,
  imageSourceCheckReady,
  extractAttachmentFileNames,
  attachmentMetadata,
  fetchExactMessageRow,
  materializeFile,
  materializeVideo,
  materializeImage,
  fetchMessageResources,
  reconcileUnindexedWechatFiles,
  findImageDatOnDisk,
  findAccountDir,
  talkerHash,
  decodeViaPython,
  downloadViaCdn,
  downloadViaAttach,
  resolveImageAttachPaths,
  registerCdnPending,
  preRegisterImageCdnPending,
  switchSessionForHd,
  sessionSwitchQuery,
  uploadViaCdn,
  extractImageCdnFields,
  classifyCapturedImageTier,
  monthDirFromTs,
  backfillWeixinV2Cache,
  rasterContentSimilarity,
  selectConsistentImageCandidate,
};
