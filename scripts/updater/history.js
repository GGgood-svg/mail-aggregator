'use strict';
const { TARGET } = require('./release');
const CODE = /^[a-z_]{1,64}$/;
const operationId = value => typeof value === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(value) ? value : null;

function records(value) {
  return (Array.isArray(value) ? value.slice(0, 60) : []).flatMap(item => {
    if (!item || !operationId(item.operationId) || !TARGET.test(`v${item.from}`) || !TARGET.test(`v${item.to}`) || !CODE.test(item.outcome || '')) return [];
    return [{ operationId: item.operationId, from: item.from, to: item.to, outcome: item.outcome,
      source: ['automatic','manual'].includes(item.source) ? item.source : 'unknown', reason: CODE.test(item.reason || '') ? item.reason : null,
      at: Number.isSafeInteger(item.at) ? item.at : null, startedAt: Number.isSafeInteger(item.startedAt) ? item.startedAt : null }];
  });
}
function historyPage(history, pageValue, sizeValue) {
  const all = records(history);
  const integer = (value, fallback) => /^\d{1,6}$/.test(String(value ?? '')) ? Math.max(1, Number(value)) : fallback;
  const pageSize = Math.min(20, integer(sizeValue, 10));
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, integer(pageValue, 1));
  return { items: all.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, totalPages } };
}
module.exports = { records, historyPage, operationId };
