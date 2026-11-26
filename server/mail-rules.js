'use strict';
const { normalizeSavedSearch } = require('./saved-searches');
const { ACTIONS } = require('./mail-tasks');
const { autoPreviewFloor, supportsAutomaticPreviews } = require('./mail-auto-preview');
const { ownedLabel, positiveId } = require('./mail-labels');
const { mailError } = require('./mail-tools');
const { track } = require('./update-activity');
const MAX_RULES = 50;
function normalizeRule(input) {
  if (!input || !Object.hasOwn(ACTIONS, input.action) && input.action !== 'label') throw mailError('整理动作不合法');
  const { action, labelId, autoPreviewEnabled = false, ...search } = input;
  if (typeof autoPreviewEnabled !== 'boolean') throw mailError('自动预览设置不合法');
  if (action !== 'label' && labelId != null) throw mailError('整理动作不合法');
  return { ...normalizeSavedSearch(search, { allowAttachments: false }), action, autoPreviewEnabled,
    ...(action === 'label' ? { labelId: positiveId(labelId) } : {}) };
}
function registerMailTaskRoutes(router, { getService, authorize }) {
  const route = handler => track(async (req, res) => {
    try { authorize(req); await handler(req, res, getService()); }
    catch (error) { if (!res.destroyed) res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '邮件任务暂时不可用，请稍后重试' }); }
  });
  const context = req => ({ user: { ...req.user }, sessionID: req.sessionID,
    session: req.session && { userId: req.session.userId, sessionVersion: req.session.sessionVersion } });
  router.get('/tasks', route((req, res, service) => res.json(service.list(req.user.id, req.query.page, req.query.pageSize))));
  router.post('/tasks', route((req, res, service) => {
    if (req.body?.type !== 'seen_all' || Object.keys(req.body).some(key => !['type', 'folders'].includes(key))) throw mailError('邮件任务参数不合法');
    res.status(202).json(service.createSeen(req.user.id, req.body.folders, context(req)));
  }));
  router.get('/tasks/:id', route((req, res, service) => res.json(service.get(req.user.id, req.params.id, context(req)))));
  router.post('/tasks/:id/cancel', route((req, res, service) => res.json(service.cancel(req.user.id, req.params.id, context(req)))));
  router.post('/tasks/:id/resume', route(async (req, res, service) => res.status(202).json(await service.resume(req.user.id, req.params.id, context(req)))));
  return { route, context };
}
function registerRuleRoutes(router, { getDb, getService, authorize, allowed, write = work => work() }) {
  const { route, context } = registerMailTaskRoutes(router, { getService, authorize });
  const owned = (req, db) => {
    if (!/^[1-9]\d{0,14}$/.test(req.params.id)) throw mailError('规则不存在', 404);
    const rule = db.prepare('SELECT * FROM mail_rules WHERE id=? AND owner_user_id=?').get(req.params.id, req.user.id);
    if (!rule) throw mailError('规则不存在', 404);
    return rule;
  };
  const serialize = (rule, req) => {
    const latest = getDb().prepare("SELECT id FROM mail_tasks WHERE owner_user_id=? AND rule_id=? AND kind='rule_preview' ORDER BY created_at DESC,id DESC LIMIT 1").get(req.user.id, rule.id);
    return { id: rule.id, name: rule.name, scope: rule.scope, folder: rule.folder, filters: JSON.parse(rule.filters_json), action: rule.action, labelId: rule.label_id ?? null,
      revision: rule.revision, autoPreviewEnabled: rule.auto_after_job_id != null, available: rule.scope === 'all' || allowed(rule.folder, authorize(req)), latestPreviewId: latest?.id || null };
  };
  router.get('/rules', route((req, res) => res.json({ rules: getDb().prepare('SELECT * FROM mail_rules WHERE owner_user_id=? ORDER BY id').all(req.user.id).map(rule => serialize(rule, req)), maximum: MAX_RULES, autoPreviewAvailable: supportsAutomaticPreviews(getDb()) })));
  router.post('/rules', route((req, res) => write(() => {
    const db = getDb(), value = normalizeRule(req.body);
    if (value.folder && !allowed(value.folder, authorize(req))) throw mailError('文件夹不存在或不属于当前用户', 404);
    if (value.labelId) ownedLabel(db, req.user.id, value.labelId);
    const info = db.prepare(`INSERT INTO mail_rules(owner_user_id,name,scope,folder,filters_json,action,label_id,auto_after_job_id)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mail_rules WHERE owner_user_id=?)<?`)
      .run(req.user.id, value.name, value.scope, value.folder, JSON.stringify(value.filters), value.action, value.labelId ?? null, autoPreviewFloor(db, value.autoPreviewEnabled), req.user.id, MAX_RULES);
    if (!info.changes) throw mailError('每个用户最多保存50条规则', 409);
    res.status(201).json(serialize(db.prepare('SELECT * FROM mail_rules WHERE id=?').get(info.lastInsertRowid), req));
  })));
  router.put('/rules/:id', route((req, res, service) => write(() => {
    const db = getDb(), current = owned(req, db), value = normalizeRule(req.body);
    if (value.folder && !allowed(value.folder, authorize(req))) throw mailError('文件夹不存在或不属于当前用户', 404);
    if (value.labelId) ownedLabel(db, req.user.id, value.labelId);
    db.transaction(() => {
      db.prepare("UPDATE mail_rules SET name=?,scope=?,folder=?,filters_json=?,action=?,label_id=?,auto_after_job_id=?,revision=revision+1,updated_at=datetime('now') WHERE id=? AND owner_user_id=?")
        .run(value.name, value.scope, value.folder, JSON.stringify(value.filters), value.action, value.labelId ?? null, autoPreviewFloor(db, value.autoPreviewEnabled), current.id, req.user.id);
      service.invalidateRule(req.user.id, current.id);
    })();
    res.json(serialize(db.prepare('SELECT * FROM mail_rules WHERE id=?').get(current.id), req));
  })));
  router.delete('/rules/:id', route((req, res, service) => write(() => {
    const db = getDb(), current = owned(req, db);
    db.transaction(() => { service.invalidateRule(req.user.id, current.id); db.prepare('DELETE FROM mail_rules WHERE id=? AND owner_user_id=?').run(current.id, req.user.id); })();
    res.json({ ok: true });
  })));
  router.post('/rules/:id/previews', route((req, res, service) => {
    const current = owned(req, getDb());
    res.status(202).json(service.createPreview(req.user.id, current, context(req)));
  }));
  router.get('/rules/:id/previews/:previewId', route((req, res, service) => {
    const rule = owned(req, getDb()), preview = service.get(req.user.id, req.params.previewId, context(req));
    if (preview.ruleId !== rule.id || preview.kind !== 'rule_preview') throw mailError('规则预览不存在', 404);
    res.json(preview);
  }));
  router.post('/rules/:id/previews/:previewId/apply', route((req, res, service) => {
    res.status(202).json(service.applyPreview(req.user.id, owned(req, getDb()), req.params.previewId, context(req)));
  }));
}
module.exports = { normalizeRule, registerRuleRoutes, MAX_RULES };
