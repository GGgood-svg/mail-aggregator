'use strict';
const { SEARCH_FILTER_KEYS, searchCriteria, mailError } = require('./mail-tools');
const { FILTER_KEYS: ATTACHMENT_FILTERS, attachmentCriteria } = require('./mail-attachment-search');
const MAX_SAVED_SEARCHES = 50;

function normalizeSavedSearch(input, { allowAttachments = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['name', 'scope', 'folder', 'filters'].includes(key))) throw mailError('保存搜索参数不合法');
  const name = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw mailError('搜索名称需为1至80个字符');
  if (!['folder', 'all'].includes(input.scope)) throw mailError('搜索范围不合法');
  let folder = null;
  if (input.scope === 'folder') {
    if (typeof input.folder !== 'string' || !input.folder.trim() || input.folder.length > 512 || /[\x00-\x1f\x7f]/.test(input.folder)) throw mailError('邮箱文件夹名称不合法');
    folder = input.folder;
  } else if (input.folder !== undefined && input.folder !== null && input.folder !== '') throw mailError('搜索范围不合法');
  const allowedFilters = allowAttachments ? [...SEARCH_FILTER_KEYS, ...ATTACHMENT_FILTERS] : SEARCH_FILTER_KEYS;
  if (!input.filters || typeof input.filters !== 'object' || Array.isArray(input.filters)
      || Object.keys(input.filters).some(key => !allowedFilters.includes(key))) throw mailError('搜索参数不合法');
  const filters = {};
  for (const key of allowedFilters) {
    if (input.filters[key] === undefined) continue;
    if (typeof input.filters[key] !== 'string') throw mailError('搜索参数不合法');
    const value = input.filters[key].trim();
    if (/[\x00-\x1f\x7f]/.test(input.filters[key])) throw mailError('搜索参数不合法');
    if (value && (!['seen', 'flagged', 'attachment'].includes(key) || value !== 'all')) filters[key] = value;
  }
  const criteria = searchCriteria(filters);
  const attachment = allowAttachments ? attachmentCriteria(filters) : null;
  if (input.scope === 'all' && !attachment && !Object.keys(criteria).length) throw mailError('请至少填写一个搜索条件');
  return { name, scope: input.scope, folder, filters };
}

function registerSavedSearchRoutes(router, { getDb, authorize, allowed, write = work => work() }) {
  const route = (work, mutation = true) => (req, res) => {
    try {
      const run = () => { const access = authorize(req); work(req, res, getDb(), access); };
      if (mutation) write(run); else run();
    }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '保存搜索暂时不可用，请稍后重试' }); }
  };
  const serialize = (row, access) => ({ id: row.id, name: row.name, scope: row.scope, folder: row.folder,
    filters: JSON.parse(row.filters_json), createdAt: row.created_at, updatedAt: row.updated_at,
    available: row.scope === 'all' || allowed(row.folder, access) });
  router.get('/saved-searches', route((req, res, db, access) => {
    const searches = db.prepare('SELECT * FROM saved_searches WHERE owner_user_id=? ORDER BY id').all(req.user.id);
    res.json({ searches: searches.map(row => serialize(row, access)), maximum: MAX_SAVED_SEARCHES });
  }, false));
  router.post('/saved-searches', route((req, res, db, access) => {
    const value = normalizeSavedSearch(req.body);
    if (value.folder && !allowed(value.folder, access)) throw mailError('文件夹不存在或不属于当前用户', 404);
    const info = db.prepare(`INSERT INTO saved_searches(owner_user_id,name,scope,folder,filters_json)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM saved_searches WHERE owner_user_id=?)<?`)
      .run(req.user.id, value.name, value.scope, value.folder, JSON.stringify(value.filters), req.user.id, MAX_SAVED_SEARCHES);
    if (!info.changes) throw mailError('每个用户最多保存50个搜索', 409);
    res.status(201).json(serialize(db.prepare('SELECT * FROM saved_searches WHERE id=?').get(info.lastInsertRowid), access));
  }));
  router.put('/saved-searches/:id', route((req, res, db, access) => {
    if (!/^[1-9]\d{0,14}$/.test(req.params.id)) throw mailError('保存的搜索不存在', 404);
    const current = db.prepare('SELECT * FROM saved_searches WHERE id=? AND owner_user_id=?').get(req.params.id, req.user.id);
    if (!current) throw mailError('保存的搜索不存在', 404);
    const value = normalizeSavedSearch(req.body);
    // Renaming an unavailable folder is allowed; changing its target requires access.
    if (value.folder && value.folder !== current.folder && !allowed(value.folder, access)) throw mailError('文件夹不存在或不属于当前用户', 404);
    db.prepare("UPDATE saved_searches SET name=?,scope=?,folder=?,filters_json=?,updated_at=datetime('now') WHERE id=? AND owner_user_id=?")
      .run(value.name, value.scope, value.folder, JSON.stringify(value.filters), current.id, req.user.id);
    res.json(serialize(db.prepare('SELECT * FROM saved_searches WHERE id=?').get(current.id), access));
  }));
  router.delete('/saved-searches/:id', route((req, res, db) => {
    if (!/^[1-9]\d{0,14}$/.test(req.params.id)) throw mailError('保存的搜索不存在', 404);
    if (!db.prepare('DELETE FROM saved_searches WHERE id=? AND owner_user_id=?').run(req.params.id, req.user.id).changes) throw mailError('保存的搜索不存在', 404);
    res.json({ ok: true });
  }));
}
module.exports = { normalizeSavedSearch, registerSavedSearchRoutes, MAX_SAVED_SEARCHES };
