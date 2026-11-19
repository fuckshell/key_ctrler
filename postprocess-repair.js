'use strict';
function repairPriorityYields(grant) {
  const history = grant?.priority_yield_history || [];
  if (!Array.isArray(history) || history.some((entry, i) =>
      entry.dispatch !== i + 1 || entry.reason !== 'temporary-new-messages-pending' ||
      entry.before_calendar !== true)) return NaN;
  return history.length;
}

function readOnlyPriorityResult(job) {
  const result = job?.result;
  const isYield = value => Boolean(value?.ok === false &&
    value.retryable === true && value.reason === 'temporary-new-messages-pending' &&
    value.path === 'context-gemini-openclaw' &&
    Object.keys(value).every(k => ['ok', 'retryable', 'reason', 'path'].includes(k)));
  if (result?.calendar === false) return isYield(result?.vision_calendar?.result);
  // handlePostprocess uses the ordinary calendar wrapper when vision is not
  // selected. This exact context result is emitted before execute_online;
  // exit 0 alone, another pipeline or any extra execution evidence is unsafe.
  const calendar = result?.calendar;
  return Boolean(result?.ok === true && result.pending === false &&
    result.vision_calendar === false && calendar?.ok === true &&
    calendar.exit_code === 0 && calendar.receipt_required === false &&
    calendar.candidate_count === 0 &&
    Object.keys(result).every(k => ['ok', 'pending', 'calendar', 'vision_calendar'].includes(k)) &&
    Object.keys(calendar).every(k => ['ok', 'result', 'exit_code', 'receipt_required', 'candidate_count'].includes(k)) &&
    isYield(calendar.result));
}

function recordRepairPriorityYield(job, {historical = false, now = new Date().toISOString()} = {}) {
  const grant = job?.repair_execution;
  const yields = repairPriorityYields(grant);
  if (!grant || !readOnlyPriorityResult(job) ||
      !Number.isInteger(grant.attempts) || grant.attempts !== yields + 1 ||
      Number(job.attempts) !== grant.attempts_before) return false;
  if (historical) {
    // Only repair the exact old accounting contradiction. A provider failure,
    // interrupted executor or completed repair never qualifies as a yield.
    if (job.status !== 'retry' || job.last_error !== 'temporary-new-messages-pending' ||
        grant.fix_id !== 'verified-middle-upgrade-v1' || grant.pending !== true ||
        grant.outcome !== 'queued' || grant.started_at || grant.attempts !== 1 || yields !== 0 ||
        grant.proof?.ok !== true || grant.proof.job_id !== job.id ||
        grant.proof.file_sha !== job.event?.media_file_sha256 ||
        grant.proof.message_key !== job.event?.media_message_key ||
        grant.proof.attempts !== job.attempts ||
        grant.proof.last_error !== grant.previous_error) return false;
    const fs = require('node:fs'), crypto = require('node:crypto');
    try {
      const bytes = fs.readFileSync(job.event.media_canonical_file);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== grant.proof.file_sha) return false;
    } catch { return false; }
  } else if (grant.pending !== false || !grant.started_at) return false;
  grant.priority_yield_history = [...(grant.priority_yield_history || []), {
    dispatch: grant.attempts, reason: 'temporary-new-messages-pending', before_calendar: true,
    started_at: grant.started_at || job.started_at, at: now,
    ...(historical ? {accounting_recovered: true, previous_finished_at: grant.finished_at} : {}),
  }];
  grant.pending = true;
  delete grant.started_at;
  return true;
}

// One verified recovery execution, separate from the original attempt budget.
function repairPending(job) {
  const grant = job?.repair_execution;
  if (!grant || grant.pending !== true || grant.started_at ||
      Number(grant.attempts || 0) !== repairPriorityYields(grant)) return false;
  if (!Number.isInteger(grant.attempts_before) || Number(job.attempts || 0) !== grant.attempts_before) return false;
  // A repair grant is a single, separately audited execution. The legacy
  // provider grant is allowed here only when it carries the same immutable
  // proof fields as a current grant; it must never renew itself.
  // A Codex self-repair receipt is diagnostic evidence only.  It must never
  // reopen an exhausted message and execute the original postprocess again.
  if (!['completed-flash-ocr-v1', 'verified-middle-upgrade-v1', 'verified-provider-retry-v1', 'verified-middle-dispatch-v2', 'terminal-resolution-v1', 'verified-screen-fallback-v1', 'verified-merged-header-v1', 'verified-flash-cache-v1', 'verified-readonly-calendar-v1', 'verified-json-schema-preflight-v1', 'terminal-resolution-v2', 'codex-root-cause-repair-v2', 'verified-source-ocr-v1', 'verified-provider-recovery-v1', 'verified-filehelper-media-recovery-v1', 'verified-filehelper-media-retry-v2'].includes(grant.fix_id)) return false;
  const proof = grant.proof;
  return Boolean(proof?.ok === true && proof.job_id === job.id &&
    Number(proof.attempts) === grant.attempts_before &&
    proof.last_error === (grant.previous_error || job.last_error));
}

function grantRepair(job, request, proof, now = new Date().toISOString()) {

  if (request.fix_id === 'verified-filehelper-media-retry-v2') {
    const old = job?.repair_execution;
    if (!job || job.status !== 'retry' || job.last_error !== 'temporary-new-messages-pending' ||
        Number(job.attempts) !== 1 || !old || old.fix_id !== 'verified-filehelper-media-recovery-v1' ||
        old.pending !== false || old.outcome !== 'retry' || Number(old.attempts) !== 1 ||
        Number(old.attempts_before) !== 1 || request.expected_attempts !== 1 ||
        request.expected_error !== job.last_error || proof?.ok !== true ||
        proof.fix_id !== request.fix_id || proof.job_id !== job.id || proof.attempts !== 1 ||
        proof.last_error !== job.last_error || proof.before_calendar !== true ||
        proof.file_sha !== job.event?.media_file_sha256 ||
        proof.message_key !== job.event?.media_message_key ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        JSON.stringify(proof.previous_execution) !== JSON.stringify(old) ||
        (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('filehelper-media-replay-not-verified');
    // This bounded replay deliberately reuses the exact middle source that
    // was already verified by the first recovery grant. Other repair grants
    // must still reject an unchanged source below.
    validateMediaPatch(job, proof, {allowSameSource: true});
    job.repair_execution_history = [...(job.repair_execution_history || []), old];
    job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true,
      attempts: 0, attempts_before: 1, media_waits_before: Number(job.media_waits || 0),
      previous_error: job.last_error, previous_exhausted: Boolean(job.retry_exhausted), proof};
    job.event = {...job.event, ...proof.event_patch};
    job.status = 'queued';
    job.updated_at = now;
    job.next_attempt_at_ms = 0;
    return job;
  }

  if (request.fix_id === 'verified-filehelper-media-recovery-v1') {
    if (!job || job.status !== 'retry' || job.last_error !== 'online-clarification-suppressed' ||
        job.retry_exhausted !== true || Number(job.attempts) !== 1 || job.repair_execution ||
        request.expected_attempts !== 1 || request.expected_error !== job.last_error ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id ||
        proof.attempts !== 1 || proof.last_error !== job.last_error || proof.before_calendar !== true ||
        proof.message_key !== (job.event?.media_message_key || job.event?.message_key) &&
          proof.message_key !== `filehelper|${job.event?.local_id}|${Math.floor(Number(job.event?.ts || 0) / 1000)}|${job.event?.msg_svr_id || '0'}` ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('filehelper-media-recovery-not-verified');
    validateMediaPatch(job, proof);
    job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true,
      attempts: 0, attempts_before: 1, media_waits_before: Number(job.media_waits || 0),
      previous_error: job.last_error, previous_exhausted: true, proof,
      original_event: {...job.event}, original_result: job.result};
    job.event = {...job.event, ...proof.event_patch};
    job.status = 'queued';
    job.updated_at = now;
    job.next_attempt_at_ms = 0;
    return job;
  }
  if (request.fix_id === 'verified-provider-recovery-v1') {
    const crypto = require('node:crypto');
    const old = job?.repair_execution;
    const root = process.env.WECHAT_WORKSPACE || '/home/su/.openclaw/workspace-wechat';
    const pipeline = root + '/skills/wechat-calendar/context_calendar_pipeline.py';
    let pipelineSha = '';
    try { pipelineSha = crypto.createHash('sha256').update(require('node:fs').readFileSync(pipeline)).digest('hex'); } catch {}
    const verified = Array.isArray(proof?.verified_requests) ? proof.verified_requests : [];
    const requestDir = root + '/state/media-api-burst/requests';
    const fs = require('node:fs');
    const requestsOk = verified.length > 0 && verified.every((r) => {
      if (!r || r.status !== 'complete' || r.provider !== 'gemini' ||
          typeof r.model !== 'string' || !/flash/i.test(r.model) ||
          !/^[a-f0-9]{64}$/.test(String(r.sha256 || '')) ||
          typeof r.file !== 'string' || r.file !== require('node:path').basename(r.file) ||
          !r.file.endsWith('.json')) return false;
      try {
        const file = requestDir + '/' + r.file;
        const raw = fs.readFileSync(file);
        const actual = crypto.createHash('sha256').update(raw).digest('hex');
        const row = JSON.parse(raw);
        return actual === r.sha256 && row.status === 'complete' && row.provider === 'gemini' &&
          typeof row.model === 'string' && /flash/i.test(row.model);
      } catch { return false; }
    });
    const healthOk = proof?.provider_health?.ok === true &&
      typeof proof.provider_health.checked_at === 'string' &&
      Date.parse(proof.provider_health.checked_at) > 0;
    if (job?.status !== 'retry' || job.last_error !== 'calendar-screen-provider-unavailable' ||
        Number(job.attempts) !== 2 || job.retry_exhausted !== true || old || job.recovery_execution ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id ||
        request.expected_attempts !== job.attempts || request.expected_error !== job.last_error ||
        proof.attempts !== job.attempts || proof.last_error !== job.last_error ||
        proof.before_calendar !== true || proof.no_mutating_executor_found !== true ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        proof.pipeline_sha256 !== pipelineSha || !/^[a-f0-9]{64}$/.test(pipelineSha) ||
        !healthOk || !requestsOk || (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('provider-recovery-not-verified');
    job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true,
      attempts: 0, attempts_before: Number(job.attempts), previous_error: job.last_error,
      previous_exhausted: Boolean(job.retry_exhausted), proof};
    job.status = 'queued';
    job.updated_at = now;
    job.next_attempt_at_ms = 0;
    return job;
  }

  if (request.fix_id === 'verified-source-ocr-v1') {
    const old = job?.repair_execution;
    if (job?.status !== 'retry' || job.attempts !== 2 || old?.pending !== false || old?.outcome !== 'retry' ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id || proof.before_calendar !== true ||
        request.expected_attempts !== job.attempts || request.expected_error !== job.last_error ||
        proof.attempts !== job.attempts || proof.last_error !== job.last_error ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        JSON.stringify(proof.previous_execution) !== JSON.stringify(old) ||
        !/^[a-f0-9]{64}$/.test(proof.verified_ocr_sha256 || '') ||
        !Array.isArray(proof.read_receipts) || proof.read_receipts.length !== 2 ||
        (job.repair_execution_history || []).some(g=>g.fix_id===request.fix_id))
      throw new Error('source-ocr-recovery-not-verified');
    const fs=require('node:fs'), crypto=require('node:crypto');
    const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (sha(proof.path) !== proof.file_sha || proof.read_receipts.some(r=>sha(r.path)!==r.sha256))
      throw new Error('source-ocr-evidence-changed');
    if (proof.event_patch) validateMediaPatch(job,proof);
    else if (proof.file_sha !== job.event.media_file_sha256 || proof.message_key !== job.event.media_message_key)
      throw new Error('source-ocr-identity-changed');
    job.repair_execution_history=[...(job.repair_execution_history || []),old];
    job.repair_execution={fix_id:request.fix_id,granted_at:now,pending:true,attempts:0,
      attempts_before:job.attempts,previous_error:job.last_error,previous_exhausted:Boolean(job.retry_exhausted),proof};
    if (proof.event_patch) job.event={...job.event,...proof.event_patch};
    job.status='queued'; job.updated_at=now; job.next_attempt_at_ms=0;
    return job;
  }
  if (request.fix_id === 'verified-json-schema-preflight-v1') {
    const old = job?.repair_execution;
    if (job?.status !== 'retry' || job.last_error !== 'calendar-screen-provider-unavailable' ||
        job.attempts !== 2 || job.recovery_execution || old?.fix_id !== 'verified-readonly-calendar-v1' ||
        old.pending !== false || old.outcome !== 'retry' || old.attempts !== 1 ||
        old.started_at !== job.started_at || old.attempts_before !== job.attempts ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id ||
        request.expected_attempts !== job.attempts || request.expected_error !== job.last_error ||
        proof.attempts !== job.attempts || proof.last_error !== job.last_error ||
        proof.no_mutating_executor_found !== true || !/^[a-f0-9]{64}$/.test(proof.zero_generation_preflight?.request || '') ||
        JSON.stringify(proof.previous_execution) !== JSON.stringify(old) ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('schema-preflight-resume-not-verified');
    const fs=require('node:fs'), crypto=require('node:crypto');
    const root=process.env.WECHAT_WORKSPACE || '/home/su/.openclaw/workspace-wechat';
    for (const [file, expected] of [
      ['skills/wechat-media/readonly_calendar_proof.py', proof.verifier_sha256],
      ['skills/wechat-calendar/context_calendar_pipeline.py', proof.screen_sha256],
      ['skills/wechat-media/flash_backlog_api.py', proof.client_sha256],
      ['state/media-api-burst/requests/'+proof.zero_generation_preflight.request+'.json', proof.zero_generation_preflight.sha256],
    ]) {
      if (!/^[a-f0-9]{64}$/.test(expected || '') ||
          crypto.createHash('sha256').update(fs.readFileSync(root+'/'+file)).digest('hex') !== expected)
        throw new Error('schema-preflight-source-changed');
    }
    job.repair_execution_history=[...(job.repair_execution_history || []), old];
    job.repair_execution={fix_id:request.fix_id, granted_at:now,pending:true,attempts:0,
      attempts_before:job.attempts,previous_error:job.last_error,
      previous_exhausted:Boolean(job.retry_exhausted),proof};
    job.status='queued'; job.updated_at=now; job.next_attempt_at_ms=0;
    return job;
  }
  if (request.fix_id === 'verified-readonly-calendar-v1') {
    if (job?.status !== 'retry' || !['online-calendar-failed', 'online-rate-limit'].includes(job.last_error) || job.attempts !== 2 ||
        job.repair_execution || job.recovery_execution || proof?.ok !== true || proof.fix_id !== request.fix_id ||
        proof.job_id !== job.id || proof.no_mutating_executor_found !== true ||
        request.expected_attempts !== job.attempts || request.expected_error !== job.last_error ||
        proof.attempts !== job.attempts || proof.last_error !== job.last_error ||
        !Array.isArray(proof.verified_handoffs) || !Array.isArray(proof.verified_sessions) ||
        !(proof.verified_handoffs.length || proof.verified_sessions.length) ||
        proof.verified_handoffs.some(x => x.proof?.mutations !== false) ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('calendar-readonly-execution-not-verified');
    const fs = require('node:fs'), crypto = require('node:crypto');
    const root = process.env.WECHAT_WORKSPACE || '/home/su/.openclaw/workspace-wechat';
    for (const [file, expected] of [
      ['skills/wechat-antigravity/handoff.py', proof.handoff_sha256],
      ['skills/wechat-media/readonly_calendar_proof.py', proof.verifier_sha256],
      ...(job.last_error === 'online-rate-limit' ? [['skills/wechat-calendar/context_calendar_pipeline.py', proof.screen_sha256],
        ['skills/wechat-media/flash_backlog_api.py', proof.client_sha256]] : []),
    ]) {
      if (!/^[a-f0-9]{64}$/.test(expected || '') ||
          crypto.createHash('sha256').update(fs.readFileSync(root+'/'+file)).digest('hex') !== expected)
        throw new Error('calendar-readonly-verifier-changed');
    }
    job.repair_execution = {fix_id:request.fix_id, granted_at:now, pending:true, attempts:0,
      attempts_before:job.attempts, previous_error:job.last_error,
      previous_exhausted:Boolean(job.retry_exhausted), proof};
    job.status = 'queued'; job.updated_at = now; job.next_attempt_at_ms = 0;
    return job;
  }
  if (request.fix_id === 'verified-flash-cache-v1') {
    const old = job?.repair_execution;
    if (job?.status !== 'retry' || !['triage-providers-failed', 'generation-invalid-json'].includes(job.last_error) || job.attempts !== 2 ||
        (job.last_error === 'generation-invalid-json' && !/^[a-f0-9]{64}$/.test(proof?.verified_ocr_sha256 || '')) ||
        (old && (old.fix_id !== 'verified-middle-upgrade-v1' || old.pending !== false || old.outcome !== 'retry' ||
          old.attempts !== 1 || old.attempts_before !== job.attempts || old.proof?.file_sha !== job.event?.media_file_sha256)) ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id || proof.before_calendar !== true ||
        proof.previous_execution_started_at !== old?.started_at && !(proof.previous_execution_started_at == null && !old) ||
        request.expected_attempts !== job.attempts || request.expected_error !== job.last_error ||
        proof.attempts !== job.attempts || proof.last_error !== job.last_error ||
        proof.source_sha256 !== '2da81458ea438f26102c69fd033d78f2459d16cbb9efc0ee68c3cca56485b2ab' ||
        !/^[a-f0-9]{64}$/.test(proof.cache_sha256 || '') ||
        proof.file_sha !== job.event?.media_file_sha256 || proof.message_key !== job.event?.media_message_key ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('new-flash-cache-not-verified');
    if (old) job.repair_execution_history = [...(job.repair_execution_history || []), old];
    job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true, attempts: 0,
      attempts_before: job.attempts, previous_error: job.last_error,
      previous_exhausted: Boolean(job.retry_exhausted), proof};
    job.status = 'queued'; job.updated_at = now; job.next_attempt_at_ms = 0;
    return job;
  }
  if (request.fix_id === 'verified-merged-header-v1') {
    const old = job?.repair_execution;
    if (job?.status !== 'retry' || job.last_error !== 'table-row-mapping-incomplete' ||
        old?.fix_id !== 'verified-middle-upgrade-v1' || old.pending !== false || old.outcome !== 'retry' ||
        !old.started_at || old.started_at !== job.started_at ||
        old.attempts !== repairPriorityYields(old) + 1 ||
        old.attempts_before !== job.attempts || proof?.before_calendar !== true ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id ||
        proof.previous_execution_started_at !== old.started_at ||
        request.expected_attempts !== job.attempts || request.expected_error !== job.last_error ||
        proof.attempts !== job.attempts || proof.last_error !== job.last_error ||
        proof.source_sha256 !== 'fdb4e52d3ebf4a0975e7785adffe8862014659e01df94779dac13c46383e82af' ||
        proof.file_sha !== job.event?.media_file_sha256 || proof.file_sha !== old.proof?.file_sha ||
        proof.message_key !== job.event?.media_message_key ||
        JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
        JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
        (job.repair_execution_history || []).some(g => g.fix_id === request.fix_id))
      throw new Error('merged-header-repair-not-verified');
    job.repair_execution_history = [...(job.repair_execution_history || []), old];
    job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true,
      attempts: 0, attempts_before: job.attempts, previous_error: job.last_error,
      previous_exhausted: Boolean(job.retry_exhausted), proof};
    job.status = 'queued'; job.updated_at = now; job.next_attempt_at_ms = 0;
    return job;
  }
  if (request.fix_id === 'verified-middle-dispatch-v2') {
    const old = job?.repair_execution;
    if (job?.status !== 'retry' || old?.fix_id !== 'verified-middle-upgrade-v1' ||
        old.outcome !== 'retry' || old.pending !== false ||
        job.result?.terminal_resolution !== true ||
        job.result?.reason !== 'terminal-resolution-no-new-evidence' ||
        proof?.ok !== true || proof.fix_id !== request.fix_id || proof.job_id !== job.id ||
        proof.blocked_execution_started_at !== old.started_at ||
        request.expected_attempts !== Number(job.attempts || 0) ||
        request.expected_error !== job.last_error || proof.attempts !== request.expected_attempts ||
        proof.last_error !== job.last_error || proof.file_sha !== job.event?.media_file_sha256 ||
        proof.file_sha !== old.proof?.file_sha)
      throw new Error('blocked-middle-dispatch-not-verified');
    job.repair_execution_history = [...(job.repair_execution_history || []), old];
    job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true,
      attempts: 0, attempts_before: Number(job.attempts || 0),
      previous_error: job.last_error, previous_exhausted: Boolean(job.retry_exhausted), proof};
    job.status = 'queued'; job.updated_at = now; job.next_attempt_at_ms = 0;
    return job;
  }

  if (request.fix_id === 'codex-root-cause-repair-v2') {
    const crypto = require('node:crypto');
    const old = job?.repair_execution;
    const eventSha = job?.event
      ? crypto.createHash('sha256').update(JSON.stringify(job.event)).digest('hex') : '';
    if (!job || job.status !== 'retry' || job.retry_exhausted !== true ||
        !old || old.pending !== false || job.recovery_execution ||
        job.codex_root_cause_repair_v2 ||
        request.expected_attempts !== Number(job.attempts || 0) ||
        request.expected_error !== job.last_error ||
        proof?.ok !== true || proof.fix_id !== request.fix_id ||
        proof.job_id !== job.id || proof.attempts !== Number(job.attempts || 0) ||
        proof.last_error !== job.last_error ||
        proof.event_sha256 !== eventSha ||
        !/^[a-f0-9]{64}$/.test(proof.event_sha256 || '') ||
        !proof.receipt_id || proof.receipt_request_id !== proof.request_id ||
        !proof.request_id ||
        !/^[a-f0-9]{64}$/.test(proof.audit_sha256 || '') ||
        !Number.isInteger(Number(proof.changed_files)) || Number(proof.changed_files) < 1)
      throw new Error('codex-root-cause-proof-invalid');
    job.repair_execution_history = [...(job.repair_execution_history || []), old];
    job.repair_execution = {
      fix_id: request.fix_id, job_id: job.id, granted_at: now, pending: true,
      attempts: 0, attempts_before: Number(job.attempts || 0),
      media_waits_before: Number(job.media_waits || 0),
      previous_error: job.last_error, previous_exhausted: true, proof,
    };
    job.codex_root_cause_repair_v2 = {
      granted_at: now, receipt_id: proof.receipt_id,
      request_id: proof.request_id, audit_sha256: proof.audit_sha256,
      event_sha256: proof.event_sha256, changed_files: Number(proof.changed_files),
    };
    job.status = 'queued';
    job.updated_at = now;
    job.next_attempt_at_ms = 0;
    return job;
  }

  if (!job || job.status !== 'retry') throw new Error('repair-job-not-terminal');
  if (job.repair_execution) throw new Error('repair-already-granted');
  if (!['completed-flash-ocr-v1','verified-middle-upgrade-v1','verified-screen-fallback-v1'].includes(request.fix_id) || proof?.fix_id !== request.fix_id ||
      proof?.ok !== true || proof?.job_id !== job.id) throw new Error('repair-not-verified');
  if (request.expected_attempts !== Number(job.attempts || 0) ||
      request.expected_error !== job.last_error ||
      proof.attempts !== request.expected_attempts || proof.last_error !== job.last_error ||
      (proof.previous_file_sha || proof.file_sha) !== job.event?.media_file_sha256) throw new Error('repair-job-changed');
  if (request.fix_id === 'completed-flash-ocr-v1' && !/^[a-f0-9]{64}$/.test(proof.ocr_sha256 || '')) throw new Error('repair-ocr-proof-missing');
  if (request.fix_id === 'verified-middle-upgrade-v1') validateMediaPatch(job, proof);
  if (request.fix_id === 'verified-screen-fallback-v1' &&
      (job.last_error !== 'online-rate-limit' || Number(job.attempts) !== 2 ||
       proof.no_mutating_executor_found !== true || !/^[a-f0-9]{64}$/.test(proof.pipeline_sha256 || '') ||
       JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
       JSON.stringify(proof.original_result) !== JSON.stringify(job.result))) throw new Error('screen-recovery-not-verified');
  job.repair_execution = {fix_id: request.fix_id, granted_at: now, pending: true,
    attempts: 0, attempts_before: Number(job.attempts || 0), media_waits_before: Number(job.media_waits || 0),
    previous_error: job.last_error, previous_exhausted: Boolean(job.retry_exhausted),
    proof, ...(proof.event_patch ? {original_event: {...job.event}} : {})};
  if (proof.event_patch) job.event = {...job.event, ...proof.event_patch};
  job.status = 'queued';
  job.updated_at = now;
  job.next_attempt_at_ms = 0;
  // Keep failure/counters; the grant retains the original event for source upgrades.
  return job;
}


// Code-change audits diagnose a worker repair, never the original message.
// Original jobs resume only through grantRepair() and its independent,
// message/source-specific verifier. Keep this export to reject legacy callers.
function grantRootCauseRepair() {
  throw new Error('independent-message-proof-required');
}

// Legacy diagnostic classification; it no longer authorizes an execution.
const PROVIDER_RETRY_REASONS = new Set([
  'no-manifest-image', 'no-image-file', 'waiting-media',
  'waiting-media-upgrade', 'image-tier-not-ready',
  'online-calendar-failed', 'online-clarification-suppressed',
  'online-rate-limit', 'online-auth', 'online-spend-cap',
  'calendar-receipt-missing', 'timeout', 'triage-providers-failed',
  'ocr-cache-empty', 'schedule-row-mapping-incomplete',
  'temporary-new-messages-pending', 'retry-limit-reached',
  'stale-retry-abandoned-by-retry-cap:backlog-quarantined',
]);

function isProviderRetryEligible(reason) {
  const text = String(reason || '');
  if (PROVIDER_RETRY_REASONS.has(text)) return true;
  return /^stale-retry-abandoned-by-retry-cap:/.test(text);
}

// Automatic retries use the original bounded attempt budget. A service or
// network repair cannot authorize replay of an exhausted calendar operation.
function grantProviderRetry() {
  throw new Error('automatic-provider-replay-disabled');
}

function validateMediaPatch(job, proof, {allowSameSource = false} = {}) {
  const patch = proof.event_patch;
  const event = job.event || {};
  const eventMessageKey = event.media_message_key || event.message_key ||
    (event.talker === 'filehelper' && Number.isFinite(Number(event.local_id)) && event.ts != null
      ? `filehelper|${Number(event.local_id)}|${Math.floor(Number(event.ts) / 1000)}|${String(event.msg_svr_id || '0')}`
      : '');
  const allowed = new Set(['media_path','media_file','media_canonical_file','media_file_sha256','media_middle_sha256',
    'media_thumbnail_sha256','media_captured_tier','media_middle_pending','media_hd_pending',
    'media_hd_requested','media_status','media_recovered','media_message_key']);
  if (!patch || Object.keys(patch).some(k=>!allowed.has(k)) ||
      !/^[a-f0-9]{64}$/.test(proof.file_sha || '') ||
      patch.media_file_sha256 !== proof.file_sha || patch.media_middle_sha256 !== proof.file_sha ||
      (!allowSameSource && proof.file_sha === event.media_file_sha256) ||
      proof.message_key !== eventMessageKey ||
      patch.media_captured_tier !== 'middle' || patch.media_status !== 'ready' ||
      patch.media_middle_pending !== false || patch.media_hd_pending !== false ||
      patch.media_hd_requested !== false || patch.media_recovered !== true ||
      typeof patch.media_path !== 'string' || patch.media_path !== patch.media_canonical_file || patch.media_file !== patch.media_path)
    throw new Error('repair-media-proof-invalid');
}

function refreshQueuedMedia(job, proof, now = new Date().toISOString()) {
  if (job.status !== 'queued' || job.repair_execution || job.media_source_refresh ||
      proof.ok !== true || proof.fix_id !== 'verified-middle-upgrade-v1' || proof.job_id !== job.id ||
      proof.attempts !== Number(job.attempts || 0) || proof.last_error !== job.last_error ||
      proof.previous_file_sha !== job.event?.media_file_sha256) throw new Error('repair-job-changed');
  validateMediaPatch(job, proof);
  job.media_source_refresh = {at:now, original_event:{...job.event}, proof};
  job.event = {...job.event,...proof.event_patch};
  job.updated_at = now;
  // This only refreshes input. Existing eligibility, budget and backoff survive.
  return job;
}


function mergeCompletedCalendar(job, proof, classify, now = new Date().toISOString()) {
  if (!job || !['queued','retry'].includes(job.status) || job.calendar_result_recovery ||
      proof?.ok !== true || proof.fix_id !== 'completed-calendar-final-v1' || proof.job_id !== job.id ||
      proof.attempts !== Number(job.attempts || 0) || proof.last_error !== job.last_error ||
      JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
      JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
      !proof.verified_sessions?.length || !classify(proof.result).ok)
    throw new Error('calendar-recovery-not-verified');
  job.calendar_result_recovery = {at:now, fix_id:proof.fix_id,
    attempts_before:Number(job.attempts || 0), previous_error:job.last_error,
    previous_exhausted:Boolean(job.retry_exhausted), original_result:job.result,
    verified_sessions:proof.verified_sessions};
  job.result = proof.result;
  job.status = 'succeeded';
  // Calendar reconciliation is the authoritative completion for this job.
  // Close any stale top-level self-repair marker so dashboards do not keep
  // showing a completed calendar job as under repair. Keep nested Codex
  // dispatch records unchanged because they are historical evidence.
  if (job.self_repair && job.self_repair.status !== 'succeeded') {
    job.self_repair.previous_status = job.self_repair.status;
    job.self_repair.status = 'succeeded';
    job.self_repair.completed_at = now;
    job.self_repair.normalized_reason = 'calendar-reconciliation-succeeded';
  }
  job.last_error = null;
  job.retry_exhausted = false;
  job.updated_at = now;
  job.completed_at = now;
  delete job.failure_detail;
  return job;
}


function isPreCalendarImageWait(result) {
  if (!result) return false;
  const expected = {ok:false, terminal_resolution:true,
    reason:'terminal-resolution-no-new-evidence', detail:'image-tier-not-ready'};
  const legacy = Object.keys(result).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key,value]) => result[key] === value);
  const failed = result.vision_calendar?.result;
  return legacy || (result.calendar === false && result.pending === true &&
    failed?.ok === false && failed.reason === 'image-tier-not-ready' && !failed.session_key);
}

function mergeCompletedIrrelevantMedia(job, proof, classify, now = new Date().toISOString()) {
  const media = proof?.verified_media;
  const final = proof?.result?.vision_calendar?.result;
  if (!job || !['queued','retry'].includes(job.status) || job.media_result_recovery ||
      proof?.ok !== true || proof.fix_id !== 'completed-irrelevant-media-v1' || proof.job_id !== job.id ||
      proof.attempts !== Number(job.attempts || 0) || proof.last_error !== job.last_error ||
      job.last_error !== 'image-tier-not-ready' || !isPreCalendarImageWait(job.result) ||
      job.memory_status !== 'succeeded' ||
      JSON.stringify(proof.original_event) !== JSON.stringify(job.event) ||
      JSON.stringify(proof.original_result) !== JSON.stringify(job.result) ||
      !media?.archive_key || media.file_sha !== job.event?.media_file_sha256 ||
      media.message_key !== job.event?.media_message_key ||
      media.screening_relevance !== 'irrelevant' || media.coarse_source_verified !== true ||
      final?.reason !== 'local-irrelevant' || final.file_sha !== media.file_sha ||
      final.message_key !== media.message_key || final.archive_key !== media.archive_key ||
      final.historical_actions_replayed !== false || proof.result.calendar !== false ||
      !classify(proof.result).ok) throw new Error('media-completion-not-verified');
  job.media_result_recovery = {at:now, fix_id:proof.fix_id,
    attempts_before:Number(job.attempts || 0), previous_error:job.last_error,
    previous_exhausted:Boolean(job.retry_exhausted), original_result:job.result,
    verified_media:media};
  job.result = proof.result;
  job.status = 'succeeded';
  if (job.self_repair && job.self_repair.status !== 'succeeded') {
    job.self_repair.previous_status = job.self_repair.status;
    job.self_repair.status = 'succeeded';
    job.self_repair.completed_at = now;
    job.self_repair.normalized_reason = 'media-reconciliation-succeeded';
  }
  job.last_error = null;
  job.retry_exhausted = false;
  job.updated_at = now;
  job.completed_at = now;
  delete job.failure_detail;
  return job;
}

module.exports = {isPreCalendarImageWait, repairPending, recordRepairPriorityYield, grantRepair, grantRootCauseRepair, grantProviderRetry, isProviderRetryEligible, refreshQueuedMedia, mergeCompletedCalendar, mergeCompletedIrrelevantMedia};
