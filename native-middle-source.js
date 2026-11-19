// Exact native middle acquisition receipts; never a business task queue.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const inFlight = new Set();

function needsNativeMiddle(row, {requested = false, coarse = {}, spam = false} = {}) {
  if (requested) return true;
  if (spam || row.filtered_low_value || ['filtered', 'discarded', 'done'].includes(row.status)) return false;
  // Legacy "all documents need detail" decisions predate the teacher-role
  // policy. They cannot authorize downloads; rescreening/user demand must do so.
  // Older durable Flash screening records predate screening_relevance.  They
  // still carry the trusted provider, a needs_detail decision, and direct
  // evidence; treating the missing field as an unresolved/uncertain result
  // keeps source acquisition moving without claiming the image is relevant.
  const legacyUncertain = !coarse.screening_relevance &&
    Array.isArray(coarse.evidence) && coarse.evidence.length > 0;
  return coarse.ok === true && coarse.screening_decision === 'needs_detail' &&
    (['relevant', 'uncertain'].includes(coarse.screening_relevance) || legacyUncertain) &&
    /flash/i.test(coarse.model || '') && !/pro|argon|auto/i.test(coarse.model || '') &&
    ['gemini', 'antigravity-subscription'].includes(coarse.provider);
}

function nativeIdentity(row) {
  const server = row.server_id;
  const created = Number(row.message_create_time || Math.floor(Number(row.ts || 0) / 1000));
  if (typeof server !== 'string' || !/^[1-9][0-9]{0,19}$/.test(server) ||
      BigInt(server) > 18446744073709551615n || !row.talker ||
      !Number.isSafeInteger(created) || created <= 0 || created > 2147483647 ||
      !Number.isSafeInteger(Number(row.local_id)) || Number(row.local_id) <= 0) return null;
  return {id: Number(row.local_id), talker: row.talker, server_id: server,
    create_time: created, fileType: 2};
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

async function requestNativeMiddle(row, {stateDir, request, now = Date.now()}) {
  const identity = nativeIdentity(row);
  if (!identity) return {error: 'exact-native-identity-required'};
  const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const file = path.join(stateDir, key + '.json');
  if (inFlight.has(key)) return {error: 'native-request-in-flight'};
  inFlight.add(key);
  try {
    let state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) {
      if (err.code !== 'ENOENT') return {error: 'native-receipt-unreadable'};
      state = {identity, attempts: 0};
    }
    if (JSON.stringify(state.identity) !== JSON.stringify(identity)) return {error: 'native-receipt-identity-conflict'};
    if (state.submitted || state.terminal || now < Number(state.next_check_at || 0)) return state;
    const valid = r => r?.method === 'exact_native_middle_v1' && r.native_instance &&
      r.server_id === identity.server_id && Number(r.local_id) === identity.id;
    let receipt;
    try { receipt = await request({...identity, receipt_only: true}); }
    catch (err) {
      state.error = String(err.message || err).slice(0, 180);
      state.next_check_at = now + 60000; save(file, state); return state;
    }
    if (!valid(receipt)) {
      state.error = 'exact-native-capability-or-identity-mismatch';
      state.next_check_at = now + 60000; save(file, state); return state;
    }
    const absent = receipt.ret === 404 && /no_operation_started/.test(receipt.retmsg || '');
    if (!absent) {
      state.receipt = receipt;
      state.submitted = receipt.submitted === true && receipt.identity_verified === true;
      state.terminal = !state.submitted && receipt.ret !== 202 && !/not_submitted/.test(receipt.retmsg || '');
      state.next_check_at = now + 60000;
      state.native_instance = state.native_instance || receipt.native_instance;
      save(file, state); return state;
    }
    // After transport loss/restart, absent receipts in a DIFFERENT Hook
    // instance cannot prove that the previous instance never submitted it.
    if (state.outcome_unknown && state.native_instance !== receipt.native_instance) {
      state.error = 'native-instance-changed-outcome-unknown';
      state.next_check_at = now + 60000; save(file, state); return state;
    }
    if (Number(state.attempts) >= 2) {
      state.error = 'native-submit-limit-2'; state.terminal = true;
      save(file, state); return state;
    }
    state.attempts += 1;
    state.native_instance = receipt.native_instance;
    state.outcome_unknown = true;
    state.next_check_at = now + 60000;
    save(file, state); // persist BEFORE crossing the submission boundary
    let result;
    try { result = await request({...identity, receipt_only: false}); }
    catch (err) {
      state.error = String(err.message || err).slice(0, 180);
      save(file, state); return state;
    }
    if (!valid(result)) {
      state.error = 'exact-native-submit-receipt-invalid'; save(file, state); return state;
    }
    state.receipt = result;
    state.submitted = result.submitted === true && result.identity_verified === true;
    const notSubmitted = /(?:^|; )not_submitted(?:;|$)/.test(result.retmsg || '');
    state.outcome_unknown = !state.submitted && !notSubmitted && result.ret === 202;
    state.terminal = !state.submitted && !notSubmitted && result.ret !== 202;
    save(file, state);
    return state;
  } finally { inFlight.delete(key); }
}

module.exports = {needsNativeMiddle, nativeIdentity, requestNativeMiddle};
