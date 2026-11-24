const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {after, test} = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovered-middle-reconcile-"));
process.env.WECHAT_WORKSPACE = root;
process.env.WECHAT_POSTPROCESS_JOB_FILE = path.join(root, "state/jobs.json");
process.env.WECHAT_CODEX_REPAIR_DIR = path.join(root, "repair");
fs.mkdirSync(path.join(root, "state"), {recursive: true});
fs.writeFileSync(path.join(root, "state/ingest-maintenance-pause"), "test");
const {loadPostprocessJobs, reconcileRecoveredMediaJobs} = require("../wechat-ingest");

after(() => fs.rmSync(root, {recursive: true, force: true}));

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeManifest(rows) {
  const manifest = path.join(root, "media/manifest.jsonl");
  fs.mkdirSync(path.dirname(manifest), {recursive: true});
  fs.writeFileSync(manifest, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

function writeJobs(jobs) {
  fs.writeFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE,
    JSON.stringify({version: 1, jobs}, null, 2));
  loadPostprocessJobs();
}

function imageJob(id, key, error, sourceSha, localId) {
  return {
    id, status: "queued", attempts: 1, last_error: error,
    event: {
      media_kind: "image", talker: "chat@chatroom", content: "[图片]",
      media_message_key: key, media_local_id: localId, media_server_id: "server-" + localId,
      ts: 1795050000000 + localId, media_file_sha256: sourceSha,
      media_thumbnail_sha256: sourceSha, media_captured_tier: "thumbnail",
      media_middle_pending: true,
    },
  };
}

test("reconciles a recovered middle source for image-tier waits", () => {
  const bytes = Buffer.from("verified-middle-image");
  const middlePath = path.join(root, "middle.jpg");
  fs.writeFileSync(middlePath, bytes);
  const middleSha = sha(bytes);
  const key = "chat@chatroom|11|1795050001|server-11";
  writeManifest([{message_key: key, talker: "chat@chatroom", local_id: 11,
    server_id: "server-11", ts: 1795050001000, kind: "image", status: "pending",
    captured_tier: "middle", file: middlePath, middle_sha256: middleSha,
    file_sha: middleSha, thumbnail_sha256: "a".repeat(64), middle_pending: false}]);
  const job = imageJob("middle-image-tier", key, "image-tier-not-ready", "a".repeat(64), 11);
  writeJobs([job]);
  assert.deepEqual(reconcileRecoveredMediaJobs("2026-11-19T00:00:00.000Z"), {changed: 1});
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE)).jobs[0];
  assert.equal(saved.status, "queued");
  assert.equal(saved.last_error, null);
  assert.equal(saved.event.media_file_sha256, middleSha);
  assert.equal(saved.event.media_captured_tier, "middle");
  assert.equal(saved.event.media_middle_pending, false);
  assert.equal(saved.next_attempt_at_ms, 0);
  assert.equal(saved.media_source_refresh.reason, "manifest-middle-reconciled");
});

test("reconciles temporary-new-messages-pending after middle recovery", () => {
  const bytes = Buffer.from("second-verified-middle");
  const middlePath = path.join(root, "middle-2.jpg");
  fs.writeFileSync(middlePath, bytes);
  const middleSha = sha(bytes);
  const key = "chat@chatroom|12|1795050002|server-12";
  writeManifest([{message_key: key, talker: "chat@chatroom", local_id: 12,
    server_id: "server-12", ts: 1795050002000, kind: "image", status: "pending",
    captured_tier: "middle", file: middlePath, middle_sha256: middleSha,
    file_sha: middleSha, thumbnail_sha256: "b".repeat(64), middle_pending: false}]);
  writeJobs([imageJob("middle-temporary-wait", key, "temporary-new-messages-pending", "b".repeat(64), 12)]);
  assert.deepEqual(reconcileRecoveredMediaJobs("2026-11-19T00:00:00.000Z"), {changed: 1});
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE)).jobs.find(job => job.id === "middle-temporary-wait");
  assert.ok(saved);
  assert.equal(saved.last_error, null);
  assert.equal(saved.event.media_file_sha256, middleSha);
  // A second pass after a scheduling yield must preserve the real backoff.
  saved.last_error = "temporary-new-messages-pending";
  saved.next_attempt_at_ms = 123456789;
  writeJobs([saved]);
  const before = fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE, "utf8");
  assert.deepEqual(reconcileRecoveredMediaJobs(), {changed: 0});
  assert.equal(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE, "utf8"), before);
});

test("reopens an exhausted temporary wait only after verified middle recovery", () => {
  const bytes = Buffer.from("exhausted-temporary-wait-middle");
  const middlePath = path.join(root, "middle-exhausted.jpg");
  fs.writeFileSync(middlePath, bytes);
  const middleSha = sha(bytes);
  const key = "chat@chatroom|15|1795050005|server-15";
  writeManifest([{message_key: key, talker: "chat@chatroom", local_id: 15,
    server_id: "server-15", ts: 1795050005000, kind: "image", status: "pending",
    captured_tier: "middle", file: middlePath, middle_sha256: middleSha,
    file_sha: middleSha, thumbnail_sha256: "c".repeat(64), middle_pending: false}]);
  const job = imageJob("middle-exhausted-temporary", key, "retry-limit-reached", "c".repeat(64), 15);
  job.attempts = 2;
  job.retry_exhausted = true;
  job.status = "retry";
  job.media_source_refresh = {previous_error: "temporary-new-messages-pending"};
  job.result = {pending: true, vision_calendar: {result: {
    reason: "temporary-new-messages-pending"}}};
  writeJobs([job]);
  assert.deepEqual(reconcileRecoveredMediaJobs("2026-11-19T00:00:00.000Z"), {changed: 1});
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE)).jobs
    .find(item => item.id === "middle-exhausted-temporary");
  assert.equal(saved.status, "queued");
  assert.equal(saved.retry_exhausted, false);
  assert.equal(saved.attempts, 2);
  assert.equal(saved.recovery_execution.fix_id, "verified-middle-recovery-v1");
  assert.equal(saved.recovery_execution.pending, true);
  assert.equal(saved.recovery_execution.proof.file_sha, middleSha);
});

test("does not upgrade thumbnail-only or filtered records", () => {
  const thumbBytes = Buffer.from("thumbnail-only");
  const thumbPath = path.join(root, "thumb.jpg");
  fs.writeFileSync(thumbPath, thumbBytes);
  const thumbSha = sha(thumbBytes);
  const thumbKey = "chat@chatroom|13|1795050003|server-13";
  const filteredKey = "chat@chatroom|14|1795050004|server-14";
  writeManifest([
    {message_key: thumbKey, talker: "chat@chatroom", local_id: 13,
      server_id: "server-13", ts: 1795050003000, kind: "image", status: "pending",
      captured_tier: "thumbnail", file: thumbPath, file_sha: thumbSha,
      thumbnail_sha256: thumbSha, middle_pending: true},
    {message_key: filteredKey, talker: "chat@chatroom", local_id: 14,
      server_id: "server-14", ts: 1795050004000, kind: "image", status: "filtered",
      vision_state: "filtered_ad_source", vision_last_error: "filtered-ad-source-policy"},
  ]);
  const jobs = [
    imageJob("thumbnail-only", thumbKey, "image-tier-not-ready", thumbSha, 13),
    imageJob("filtered-image", filteredKey, "image-tier-not-ready", thumbSha, 14),
  ];
  writeJobs(jobs);
  assert.deepEqual(reconcileRecoveredMediaJobs("2026-11-19T00:00:00.000Z"), {changed: 0});
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE)).jobs;
  assert.equal(saved[0].last_error, "image-tier-not-ready");
  assert.equal(saved[0].event.media_captured_tier, "thumbnail");
  assert.equal(saved[1].last_error, "image-tier-not-ready");
});

test("refreshes only the verified source and preserves downstream failures", () => {
  const {refreshStaleMiddlePaths} = require("../wechat-ingest");
  const file = path.join(root, "new-middle.jpg");
  fs.writeFileSync(file, "new middle");
  const key = "chat@chatroom|23|1795050023|server-23";
  const middle = sha(fs.readFileSync(file)), thumb = "a".repeat(64);
  const job = imageJob("business-pending", key, "table-consensus-failed", thumb, 23);
  job.result = {vision_calendar: {result: {reason: "online-clarification-required"}}};
  job.evidence_status = "awaiting-evidence";
  const row = {message_key: key, talker: job.event.talker, file, captured_tier: "middle",
    kind: "image", status: "pending", middle_sha256: middle, thumbnail_sha256: thumb};
  writeJobs([job]);
  writeManifest([{...row, middle_sha256: thumb}]);
  assert.equal(refreshStaleMiddlePaths().changed, 0);
  writeManifest([row]);
  assert.equal(refreshStaleMiddlePaths().changed, 1);
  assert.equal(refreshStaleMiddlePaths().changed, 0);
  const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE)).jobs.find(j => j.id === job.id);
  assert.equal(saved.event.media_path, file);
  assert.equal(saved.event.media_file_sha256, middle);
  for (const field of ["status", "last_error", "result", "evidence_status", "attempts"]) {
    assert.deepEqual(saved[field], job[field]);
  }
});

for (const withdrawn of [false, true]) {
  test(withdrawn ? "exact recall closes the original retry once" : "late first thumbnail wakes the original job once", () => {
    const id = withdrawn ? 51 : 50;
    const key = "chat@chatroom|" + id + "|1795050050|server-" + id;
    const job = imageJob("first-source-" + id, key, withdrawn ? "no-image-file" : null, null, id);
    job.attempts = withdrawn ? 2 : 0;
    job.status = withdrawn ? "retry" : "queued";
    job.retry_exhausted = withdrawn;
    job.event.media_status = "waiting_native_middle_cache";
    const row = {talker:job.event.talker, kind:"image", local_id:id, message_key:key};
    if (withdrawn) {
      job.result = {calendar:false, pending:true, vision_calendar:{result:{
        ok:false, reason:"no-image-file", message_key:key,
      }}};
      Object.assign(row, {status:"withdrawn", source_recall:{kind:"wechat-revokemsg", message_key:key}});
    } else {
      const file = path.join(root, "late-thumb.jpg");
      fs.writeFileSync(file, "late thumbnail fixture");
      const digest = sha(fs.readFileSync(file));
      Object.assign(row, {file, status:"pending", captured_tier:"thumbnail", file_sha:digest, thumbnail_sha256:digest});
    }
    writeManifest([row]);
    writeJobs([job]);
    assert.deepEqual(reconcileRecoveredMediaJobs(), {changed:1});
    assert.deepEqual(reconcileRecoveredMediaJobs(), {changed:0});
    const saved = JSON.parse(fs.readFileSync(process.env.WECHAT_POSTPROCESS_JOB_FILE)).jobs.find(j => j.id === job.id);
    assert.equal(saved.attempts, job.attempts);
    if (withdrawn) {
      assert.equal(saved.status, "withdrawn");
      assert.equal(saved.last_error, job.last_error);
      assert.deepEqual(saved.result, job.result);
    } else {
      assert.equal(saved.event.media_path, row.file);
      assert.equal(saved.event.media_file_sha256, row.file_sha);
      assert.equal(saved.next_attempt_at_ms, 0);
    }
  });
}
