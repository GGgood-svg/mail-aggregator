'use strict';

const { mailError } = require('./mail-tools');

const MAX_UID = 4294967295;
const MAX_WINDOW = 4096;
const MAX_WINDOWS = 64;
const SEARCH_BUDGET = 'SEARCH_BUDGET_EXCEEDED';

function budgetError() {
  return Object.assign(mailError('邮件搜索超过本次扫描上限，请缩小范围后重试', 503), { code: SEARCH_BUDGET });
}

function supportsEsearch(client) {
  return client.capabilities?.has('ESEARCH') || client.enabled?.has('IMAP4REV2') ||
    ((client.capabilities?.has('IMAP4rev2') || client.capabilities?.has('IMAP4REV2')) &&
      !client.capabilities?.has('IMAP4rev1') && !client.capabilities?.has('IMAP4REV1'));
}

async function highUid(client, mailbox, beforeUid, check) {
  if (beforeUid) return beforeUid - 1;
  if (mailbox?.exists === 0) return 0;
  const next = Number(mailbox?.uidNext);
  if (Number.isSafeInteger(next) && next >= 1 && next <= MAX_UID + 1) return next - 1;
  // A single sequence FETCH can recover UIDNEXT's bound without loading UID SEARCH ALL.
  if (typeof client.fetchOne === 'function') {
    check();
    const last = await client.fetchOne('*', { uid: true });
    check();
    if (Number.isSafeInteger(last?.uid) && last.uid > 0 && last.uid <= MAX_UID) return last.uid;
  }
  throw mailError('无法确认邮箱的邮件编号范围，请刷新后重试', 502);
}

async function windowUids(client, criteria, low, high, check) {
  check();
  const result = await client.search({ ...criteria, uid: `${low}:${high}` }, { uid: true });
  check();
  if (!Array.isArray(result)) throw mailError('邮箱搜索失败，请稍后重试', 502);
  if (result.length > high - low + 1) throw budgetError();
  return [...new Set(result.filter(uid => Number.isSafeInteger(uid) && uid >= low && uid <= high))];
}

async function highestMatch(client, criteria, high, check) {
  check();
  const result = await client.search({ ...criteria, uid: `1:${high}` }, { uid: true, returnOptions: ['MAX'] });
  check();
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      (result.max !== undefined && (!Number.isSafeInteger(result.max) || result.max < 1 || result.max > high))) {
    throw mailError('邮箱搜索失败，请稍后重试', 502);
  }
  return result.max || 0;
}

async function scanNewestUids(client, criteria, mailbox, beforeUid, limit, check = () => {}) {
  check();
  let high = await highUid(client, mailbox, beforeUid, check);
  const found = [];
  const extended = supportsEsearch(client);
  const width = extended ? MAX_WINDOW : Math.min(MAX_WINDOW, Math.max(256, limit * 8));
  for (let scans = 0; high >= 1; scans++) {
    if (scans === MAX_WINDOWS) return { uids: found, nextBeforeUid: high + 1, exhausted: false, reason: 'scan_limit' };
    if (extended) {
      high = await highestMatch(client, criteria, high, check);
      if (!high) break;
    }
    const low = Math.max(1, high - width + 1);
    const items = await windowUids(client, criteria, low, high, check);
    const remaining = limit - found.length;
    found.push(...items.sort((a, b) => b - a).slice(0, remaining));
    high = low - 1;
    if (found.length === limit) {
      // This window may contain more matches than we can deliver. Restart below
      // the last delivered UID, never below the whole window in that case.
      const moreInWindow = items.length > remaining;
      const nextBeforeUid = found.at(-1);
      if (nextBeforeUid === 1 || (high === 0 && !moreInWindow && items.at(-1) === nextBeforeUid)) break;
      return { uids: found, nextBeforeUid, exhausted: false, reason: 'page_limit' };
    }
  }
  return { uids: found, nextBeforeUid: null, exhausted: true, reason: null };
}

async function newestUids(client, criteria, mailbox, beforeUid, limit, check = () => {}) {
  const result = await scanNewestUids(client, criteria, mailbox, beforeUid, limit, check);
  if (result.reason === 'scan_limit') throw budgetError();
  return result.uids;
}

async function matchingCount(client, criteria, mailbox, check = () => {}) {
  check();
  if (supportsEsearch(client)) {
    const result = await client.search(criteria, { uid: true, returnOptions: ['COUNT'] });
    check();
    if (!result || !Number.isSafeInteger(result.count) || result.count < 0) throw mailError('邮箱搜索失败，请稍后重试', 502);
    return result.count;
  }
  let high = await highUid(client, mailbox, null, check);
  if (high > MAX_WINDOW * MAX_WINDOWS) throw budgetError();
  let total = 0;
  while (high >= 1) {
    const low = Math.max(1, high - MAX_WINDOW + 1);
    total += (await windowUids(client, criteria, low, high, check)).length;
    high = low - 1;
  }
  return total;
}

module.exports = { newestUids, scanNewestUids, matchingCount, highUid, MAX_UID, SEARCH_BUDGET };
