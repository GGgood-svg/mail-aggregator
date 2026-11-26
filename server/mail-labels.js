'use strict';
const { mailError } = require('./mail-tools');
const { track } = require('./update-activity');
const MAX_LABELS = 50;
const MAX_ASSIGNMENTS = 50000;
const SCHEMA_FIELDS = ['id', 'owner_user_id', 'name'];

function initializeMailLabels(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, name_key TEXT NOT NULL, UNIQUE(owner_user_id,name_key), UNIQUE(id,owner_user_id)
  );
  CREATE TABLE IF NOT EXISTS mail_label_messages (
    label_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
    PRIMARY KEY(label_id,account_id,folder,uid_validity,uid),
    FOREIGN KEY(label_id,owner_user_id) REFERENCES mail_labels(id,owner_user_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mail_label_messages_owner ON mail_label_messages(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_mail_label_messages_account ON mail_label_messages(account_id);
  CREATE INDEX IF NOT EXISTS idx_mail_label_messages_message ON mail_label_messages(owner_user_id,account_id,folder,uid_validity,uid);`);
}

function tableExists(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function personalLabelName(value) {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  if (!name || name.length > 80 || [...name].length > 40 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name)) throw mailError('标签名称需为1至40个字符');
  return { name, key: name.toLowerCase() };
}
function positiveId(input, message = '个人标签不存在') {
  if ((typeof input !== 'number' && typeof input !== 'string') || !/^[1-9]\d{0,14}$/.test(String(input))) throw mailError(message, 404);
  return Number(input);
}
function ownedLabel(db, owner, value) {
  const label = db.prepare('SELECT id,name FROM mail_labels WHERE id=? AND owner_user_id=?').get(positiveId(value), owner);
  if (!label) throw mailError('个人标签不存在', 404);
  return label;
}
function createLabel(db, owner, value) {
  const { name, key } = personalLabelName(value);
  if (db.prepare('SELECT 1 FROM mail_labels WHERE owner_user_id=? AND name_key=?').get(owner, key)) throw mailError('已有同名标签', 409);
  const info = db.prepare('INSERT INTO mail_labels(owner_user_id,name,name_key) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM mail_labels WHERE owner_user_id=?)<?').run(owner, name, key, owner, MAX_LABELS);
  if (!info.changes) throw mailError('每个用户最多创建50个标签', 409);
  return { id: Number(info.lastInsertRowid), name };
}
function labelAccount(db, owner, localUser, folder) {
  if (!tableExists(db, 'accounts')) return null;
  const reservations = db.prepare(`SELECT owner_user_id,former_account_id,mailbox_folder FROM mailbox_ownership
    WHERE local_user=? AND (?=mailbox_folder COLLATE BINARY
      OR substr(?,1,length(mailbox_folder)+1) IN (mailbox_folder||'.',mailbox_folder||'/'))`).all(localUser, folder, folder);
  if (reservations.length !== 1 || reservations[0].owner_user_id !== Number(owner)) return null;
  const reservation = reservations[0];
  return db.prepare(`SELECT id,mailbox_folder AS root FROM accounts WHERE id=? AND owner_user_id=? AND local_user=?
    AND destination_mode='subfolder' AND mailbox_folder=? COLLATE BINARY`)
    .get(reservation.former_account_id, owner, localUser, reservation.mailbox_folder) || null;
}
function addBindings(db, labelId, owner, account, folder, validity, uids) {
  ownedLabel(db, owner, labelId);
  // Both callers hold the live IMAP mailbox with its verified UIDVALIDITY.
  // Old UIDs from other folders, other users or unmapped mailboxes are untouched.
  db.prepare(`DELETE FROM mail_label_messages WHERE owner_user_id=? AND account_id=? AND folder=? AND uid_validity<>?`)
    .run(owner, account, folder, validity);
  const count = db.prepare('SELECT COUNT(*) AS n FROM mail_label_messages WHERE owner_user_id=?').get(owner).n;
  const add = db.prepare(`INSERT OR IGNORE INTO mail_label_messages(label_id,owner_user_id,account_id,folder,uid_validity,uid) VALUES(?,?,?,?,?,?)`);
  let added = 0;
  for (const uid of uids) {
    added += add.run(labelId, owner, account, folder, validity, uid).changes;
    if (count + added > MAX_ASSIGNMENTS) throw mailError('标签关联已达上限，请移除部分关联后重试', 409);
  }
  return added;
}
function removeBinding(db, label, owner, account, folder, validity, uid) {
  return db.prepare(`DELETE FROM mail_label_messages WHERE label_id=? AND owner_user_id=? AND account_id=? AND folder=? AND uid_validity=? AND uid=?`)
    .run(label, owner, account, folder, validity, uid).changes;
}
function labelsForMessage(db, owner, account, folder, validity, uid) {
  return db.prepare(`SELECT label_id AS id FROM mail_label_messages WHERE owner_user_id=? AND account_id=? AND folder=? AND uid_validity=? AND uid=?`)
    .all(owner, account, folder, validity, uid).map(row => row.id);
}
function matchingLabels(db, label, owner, account, folder, validity, uids) {
  if (!uids.length) return new Set();
  return new Set(db.prepare(`SELECT uid FROM mail_label_messages WHERE label_id=? AND owner_user_id=? AND account_id=? AND folder=? AND uid_validity=? AND uid IN (${uids.map(() => '?').join(',')})`)
    .all(label, owner, account, folder, validity, ...uids).map(row => row.uid));
}

function restoreMailLabels(current, source, ownerIds) {
  const ids = new Map(), summary = { labelsRestored: 0, labelsSkipped: 0, labelBindingsRestored: 0, labelBindingsRetired: 0 };
  if (!tableExists(current, 'mail_labels')) return { ids, summary };
  // An application database backup does not contain the live mailbox identity.
  // Deliberately retire bindings, even if the restored account reuses its ID.
  summary.labelBindingsRetired = Number(current.prepare('DELETE FROM mail_label_messages').run().changes);
  if (!tableExists(source, 'mail_labels')) return { ids, summary };
  const fields = new Set(source.prepare('PRAGMA table_info(mail_labels)').all().map(row => row.name));
  if (!SCHEMA_FIELDS.every(key => fields.has(key))) throw Error('备份中的个人标签表结构不合法');
  const byKey = current.prepare('SELECT id FROM mail_labels WHERE owner_user_id=? AND name_key=?');
  // Node 22.12's built-in SQLite test engine does not expose iterate().
  const rows = source.prepare('SELECT id,owner_user_id,name FROM mail_labels ORDER BY id');
  for (const row of typeof rows.iterate === 'function' ? rows.iterate() : rows.all()) {
    const owner = ownerIds.get(Number(row.owner_user_id));
    if (!owner) { summary.labelsSkipped++; continue; }
    try {
      const { name, key } = personalLabelName(row.name);
      const label = byKey.get(owner, key) || createLabel(current, owner, name);
      ids.set(Number(row.id), label.id); summary.labelsRestored++;
    } catch (error) { if (![400,409].includes(error.statusCode)) throw error; summary.labelsSkipped++; }
  }
  return { ids, summary };
}

function registerMailLabelRoutes(router, { getDb, authorize, write, validateRef, resolveAccount, withReadOnly }) {
  const route = handler => track(async (req, res) => {
    try { authorize(req); await handler(req, res, getDb()); }
    catch (error) { if (!res.destroyed) res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '个人标签暂时不可用' }); }
  });
  const fields = (body, keys) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw mailError('标签请求参数不合法'); };
  router.get('/labels', route((req, res, db) => res.json({ labels: db.prepare('SELECT id,name FROM mail_labels WHERE owner_user_id=? ORDER BY id').all(req.user.id), maximum: MAX_LABELS })));
  router.post('/labels', route((req, res, db) => write(() => { fields(req.body, ['name']); res.status(201).json(createLabel(db, req.user.id, req.body.name)); })));
  router.put('/labels/:id', route((req, res, db) => write(() => {
    fields(req.body, ['name']); const label = ownedLabel(db, req.user.id, req.params.id);
    const { name, key } = personalLabelName(req.body.name);
    if (db.prepare('SELECT 1 FROM mail_labels WHERE owner_user_id=? AND name_key=? AND id<>?').get(req.user.id, key, label.id)) throw mailError('已有同名标签', 409);
    db.prepare('UPDATE mail_labels SET name=?,name_key=? WHERE id=? AND owner_user_id=?').run(name, key, label.id, req.user.id);
    res.json({ id: label.id, name });
  })));
  router.delete('/labels/:id', route((req, res, db) => write(() => {
    const label = ownedLabel(db, req.user.id, req.params.id);
    if (db.prepare("SELECT 1 FROM mail_rules WHERE owner_user_id=? AND action='label' AND label_id=?").get(req.user.id, label.id)) throw mailError('此标签仍被规则使用，请先编辑对应规则', 409);
    db.prepare('DELETE FROM mail_labels WHERE id=? AND owner_user_id=?').run(label.id, req.user.id);
    res.json({ ok: true });
  })));
  router.get('/labels/messages/:uid', route(async (req, res, db) => {
    const ref = validateRef(req.query, req.params.uid);
    const scope = resolveAccount(req, ref.folder, false);
    if (!scope) return res.json({ labelIds: [], available: false });
    await withReadOnly(req, ref, () => {
      const account = resolveAccount(req, ref.folder, true);
      if (account.id !== scope.id) throw mailError('邮件账号已变更，请刷新后重试', 409);
      res.json({ labelIds: labelsForMessage(db, req.user.id, account.id, ref.folder, ref.validity, ref.uid), available: true });
    });
  }));
  router.put('/labels/:id/messages/:uid', route(async (req, res, db) => {
    fields(req.body, ['folder', 'uidValidity', 'assigned']);
    if (typeof req.body.assigned !== 'boolean') throw mailError('标签请求参数不合法');
    const ref = validateRef(req.body, req.params.uid);
    const owner = req.user.id, label = ownedLabel(db, owner, req.params.id);
    const scope = resolveAccount(req, ref.folder, true);
    await withReadOnly(req, ref, () => write(() => db.transaction(() => {
      const account = resolveAccount(req, ref.folder, true);
      if (account.id !== scope.id) throw mailError('邮件账号已变更，请刷新后重试', 409);
      ownedLabel(db, owner, label.id);
      if (req.body.assigned) addBindings(db, label.id, owner, account.id, ref.folder, ref.validity, [ref.uid]);
      else removeBinding(db, label.id, owner, account.id, ref.folder, ref.validity, ref.uid);
      res.json({ labelIds: labelsForMessage(db, owner, account.id, ref.folder, ref.validity, ref.uid), available: true });
    })()));
  }));
}

module.exports = { initializeMailLabels, registerMailLabelRoutes, labelAccount, ownedLabel, matchingLabels, addBindings,
  createLabel, positiveId, restoreMailLabels, personalLabelName, MAX_LABELS, MAX_ASSIGNMENTS };
