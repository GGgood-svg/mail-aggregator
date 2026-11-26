'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { mailError, searchCriteria, utf8Prefix } = require('./mail-tools');
const { initializeMailLabels, ownedLabel, addBindings } = require('./mail-labels');
const maintenance = require('./maintenance-lock');
const auto = require('./mail-auto-preview');

const ACTIVE = ['queued', 'running', 'cancelling'];
const READY_SNAPSHOT = 'snapshot_ready';
const isBlockPreview = task => task.kind === 'rule_preview' && task.snapshot_format === 2;
const hasResumeScope = task => task.boundary_ready || (isBlockPreview(task) && task.preview_scope_ready);
const isTerminalTaskError = (error, signal) => signal.aborted || [401, 403, 404, 409, 410, 413, 499].includes(error.statusCode);
const PREVIEW_SAMPLE_SIZE = 3;
const PREVIEW_SCAN_TTL = 60 * 60 * 1000;
const MAX_SCAN_BATCHES_PER_FOLDER = 1024;
const PREVIEW_BATCHES_PER_CONNECTION = 4, PREVIEW_CONNECTION_SOFT_MS = 250;
const ACTIONS = { seen: ['\\Seen', true], unseen: ['\\Seen', false], star: ['\\Flagged', true], unstar: ['\\Flagged', false] };
const BATCH_SIZE = 200, MAX_FOLDERS = 500, MAX_PREVIEW_MATCHES = 50000, PREVIEW_TTL = 10 * 60 * 1000;

const ruleSchema = table => `CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('folder','all')), folder TEXT,
      filters_json TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('seen','unseen','star','unstar','label')), label_id INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((action='label' AND label_id IS NOT NULL) OR (action<>'label' AND label_id IS NULL))
    )`;

function initializeMailTasks(db) {
  initializeMailLabels(db);
  db.exec(`${ruleSchema('mail_rules')};`);
  if (!db.prepare('PRAGMA table_info(mail_rules)').all().some(row => row.name === 'label_id')) {
    const legacy = 'id,owner_user_id,name,scope,folder,filters_json,action,revision,created_at,updated_at';
    db.transaction(() => db.exec(`${ruleSchema('mail_rules_label_migration')};
      INSERT INTO mail_rules_label_migration(${legacy}) SELECT ${legacy} FROM mail_rules;
      DROP TABLE mail_rules; ALTER TABLE mail_rules_label_migration RENAME TO mail_rules;`))();
  }
  if (!db.prepare('PRAGMA table_info(mail_rules)').all().some(row => row.name === 'auto_after_job_id')) db.exec('ALTER TABLE mail_rules ADD COLUMN auto_after_job_id INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mail_rules_owner ON mail_rules(owner_user_id,id);
    CREATE TABLE IF NOT EXISTS mail_tasks (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, status TEXT NOT NULL, action TEXT, rule_id INTEGER, rule_revision INTEGER,
      spec_json TEXT NOT NULL, boundary_ready INTEGER NOT NULL DEFAULT 0, resumable INTEGER NOT NULL DEFAULT 1,
      error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, expires_at INTEGER,
      application_task_id TEXT, current_folder TEXT, phase TEXT, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mail_tasks_owner ON mail_tasks(owner_user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS mail_task_folders (
      task_id TEXT NOT NULL REFERENCES mail_tasks(id) ON DELETE CASCADE, folder TEXT NOT NULL, ordinal INTEGER NOT NULL,
      uid_validity TEXT, upper_uid INTEGER, before_uid INTEGER, cursor INTEGER NOT NULL DEFAULT 0,
      uids_json TEXT NOT NULL DEFAULT '[]', pending_json TEXT NOT NULL DEFAULT '[]', next_cursor INTEGER,
      matched_count INTEGER NOT NULL DEFAULT 0, pending_count INTEGER NOT NULL DEFAULT 0,
      confirmed INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(task_id,folder)
    );
    CREATE TABLE IF NOT EXISTS mail_task_uid_blocks (
      task_id TEXT NOT NULL, folder TEXT NOT NULL, position INTEGER NOT NULL,
      uids_json TEXT NOT NULL,
      PRIMARY KEY(task_id,folder,position),
      FOREIGN KEY(task_id,folder) REFERENCES mail_task_folders(task_id,folder) ON DELETE CASCADE
    );
  `);
  const taskColumns = new Set(db.prepare('PRAGMA table_info(mail_tasks)').all().map(row => row.name));
  if (!taskColumns.has('snapshot_format')) db.exec('ALTER TABLE mail_tasks ADD COLUMN snapshot_format INTEGER NOT NULL DEFAULT 1');
  if (!taskColumns.has('phase')) db.exec('ALTER TABLE mail_tasks ADD COLUMN phase TEXT');
  if (!taskColumns.has('updated_at')) db.exec('ALTER TABLE mail_tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  if (!taskColumns.has('automatic')) db.exec('ALTER TABLE mail_tasks ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0');
  if (!taskColumns.has('preview_scope_ready')) db.exec('ALTER TABLE mail_tasks ADD COLUMN preview_scope_ready INTEGER NOT NULL DEFAULT 0');
  auto.initializeAutomaticPreviews(db);
  const columns = new Set(db.prepare('PRAGMA table_info(mail_task_folders)').all().map(row => row.name));
  if (!columns.has('label_account_id')) db.exec('ALTER TABLE mail_task_folders ADD COLUMN label_account_id INTEGER');
  if (!columns.has('samples_json')) db.exec("ALTER TABLE mail_task_folders ADD COLUMN samples_json TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('sample_reason')) db.exec('ALTER TABLE mail_task_folders ADD COLUMN sample_reason TEXT');
  if (!columns.has('scan_batches')) db.exec('ALTER TABLE mail_task_folders ADD COLUMN scan_batches INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('updated_at')) db.exec('ALTER TABLE mail_task_folders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  for (const [column, json] of [['matched_count','uids_json'], ['pending_count','pending_json']]) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE mail_task_folders ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      for (const item of db.prepare(`SELECT task_id,folder,${json} AS value FROM mail_task_folders`).all()) {
        db.prepare(`UPDATE mail_task_folders SET ${column}=? WHERE task_id=? AND folder=?`).run(JSON.parse(item.value).length, item.task_id, item.folder);
      }
    }
  }
}

function createMailTaskService({ db, authorize, listFolders, withFolder, newestUids, scanNewestUids, now = Date.now,
  monotonicNow = () => performance.now(), folderVisibility, resolveLabelAccount, automaticPreviews,
  write = work => work(), concurrency = 2, maxQueue = 8 }) {
  initializeMailTasks(db);
  // Interactive authorization never survives a process. Interrupted automatic
  // previews may recover under fresh account/rule authorization only.
  const startedAt = now();
  db.prepare("UPDATE mail_tasks SET automatic=2 WHERE automatic=1 AND status IN ('queued','running')").run();
  const recoverableAutomatic = automaticPreviews ? db.prepare("SELECT id FROM mail_tasks WHERE automatic=2 ORDER BY created_at,id").all() : [];
  db.prepare("UPDATE mail_tasks SET status='interrupted',phase=NULL,current_folder=NULL,finished_at=?,updated_at=?,error=? WHERE status IN ('queued','running','cancelling')")
    .run(startedAt, startedAt, '服务已重启，请重新登录后手动继续');
  db.prepare(`UPDATE mail_tasks SET resumable=0
    WHERE (boundary_ready=0 AND NOT (kind='rule_preview' AND snapshot_format=2 AND preview_scope_ready=1))
       OR (kind='rule_preview' AND snapshot_format=1)`).run();
  const scanUids = scanNewestUids || (async (client, criteria, mailbox, before, limit, check) => {
    const uids = await newestUids(client, criteria, mailbox, before, limit, check);
    return { uids, nextBeforeUid: uids.at(-1), exhausted: uids.length < limit };
  });
  const isExpiredScan = task => task.kind === 'rule_preview' && task.snapshot_format === 2 && now() - task.created_at >= PREVIEW_SCAN_TTL;
  const contexts = new Map(), running = new Map();
  let closed = false, scheduled = false;
  const row = id => db.prepare('SELECT * FROM mail_tasks WHERE id=?').get(id);
  const folders = id => db.prepare('SELECT * FROM mail_task_folders WHERE task_id=? ORDER BY ordinal').all(id);
  const folderRow = (id, folder) => db.prepare('SELECT * FROM mail_task_folders WHERE task_id=? AND folder=?').get(id, folder);
  const owned = (owner, id) => {
    const task = row(id);
    if (!task || task.owner_user_id !== Number(owner)) throw mailError('任务不存在', 404);
    return task;
  };
  const saveTask = (id, values) => db.prepare(`UPDATE mail_tasks SET updated_at=?,${Object.keys(values).map(key => `${key}=?`).join(',')} WHERE id=?`).run(now(), ...Object.values(values), id);
  const saveFolder = (id, folder, values) => {
    if (Object.hasOwn(values, 'uids_json')) values.matched_count = JSON.parse(values.uids_json).length;
    if (Object.hasOwn(values, 'pending_json')) values.pending_count = JSON.parse(values.pending_json).length;
    return db.prepare(`UPDATE mail_task_folders SET updated_at=?,${Object.keys(values).map(key => `${key}=?`).join(',')} WHERE task_id=? AND folder=?`).run(now(), ...Object.values(values), id, folder);
  };
  function serialize(task, detail = true, context) {
    // Task polling never loads or parses the frozen UID sets on the Web thread.
    const metrics = db.prepare(`SELECT COUNT(*) AS total,SUM(confirmed) AS updated,SUM(matched_count) AS matched,SUM(pending_count) AS uncertain,
      MAX(updated_at) AS recent,SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS processed FROM mail_task_folders WHERE task_id=?`).get(task.id);
    const items = detail ? db.prepare(`SELECT folder,status,confirmed,missing,error,uid_validity,upper_uid,matched_count,pending_count,samples_json,sample_reason
      FROM mail_task_folders WHERE task_id=? ORDER BY ordinal`).all(task.id) : [];
    const allow = context && folderVisibility ? folderVisibility(context) : path => {
      if (!context) return true; // Internal callers never receive persisted message headers.
      try { authorize(context, path); return true; } catch (error) { if ([403, 404].includes(error.statusCode)) return false; throw error; }
    };
    const visible = items.filter(item => allow(item.folder));
    return { id: task.id, kind: task.kind, action: task.action, ruleId: task.rule_id, automatic: Boolean(task.automatic),
      status: task.status === READY_SNAPSHOT ? 'completed' : task.status, phase: ACTIVE.includes(task.status) ? task.phase ?? (task.status === 'queued' ? 'queued' : null) : null,
      updatedAt: new Date(Math.max(task.created_at, task.finished_at || 0, task.updated_at, metrics.recent || 0)).toISOString(),
      totalFolders: metrics.total, processedFolders: metrics.processed || 0,
      updated: metrics.updated || 0, matched: metrics.matched || 0,
      uncertain: metrics.uncertain || 0, currentFolder: task.current_folder && allow(task.current_folder) ? task.current_folder : null,
      error: task.error, resumable: Boolean(!task.automatic && task.resumable && hasResumeScope(task) && !ACTIVE.includes(task.status) && !['completed', READY_SNAPSHOT, 'invalidated'].includes(task.status) && !isExpiredScan(task)),
      createdAt: new Date(task.created_at).toISOString(), finishedAt: task.finished_at ? new Date(task.finished_at).toISOString() : null,
      expiresAt: task.expires_at ? new Date(task.expires_at).toISOString() : null, applicationTaskId: task.application_task_id,
      ...(detail ? { restrictedFolders: items.length - visible.length, results: visible.map(item => ({ folder: item.folder, ok: item.status === 'completed' && !item.missing,
        status: item.status, updated: item.confirmed, matched: item.matched_count,
        missing: item.missing, uncertain: item.pending_count, error: item.error,
        uidValidity: item.uid_validity, upperUid: item.upper_uid,
        ...(task.kind === 'rule_preview' && context ? { samples: JSON.parse(item.samples_json), sampleReason: item.sample_reason,
          reason: item.status === 'failed' ? 'scan_failed' : null } : {}) })) } : {}) };
  }
  function prune(owner) {
    const terminal = db.prepare("SELECT id,created_at FROM mail_tasks WHERE owner_user_id=? AND status NOT IN ('queued','running','cancelling') ORDER BY created_at DESC,id DESC").all(owner)
      .filter(task => !running.has(task.id));
    terminal.forEach((task, index) => { if (index >= 100 || task.created_at < now() - 7 * 86400000) db.prepare('DELETE FROM mail_tasks WHERE id=?').run(task.id); });
  }
  function admission(owner, context) {
    if (closed || maintenance.current() === 'restore') throw mailError('系统正在维护，请稍后创建或继续任务', 409);
    authorize(context);
    const active = db.prepare("SELECT id,owner_user_id,status FROM mail_tasks WHERE status IN ('queued','running','cancelling')").all();
    if (active.some(item => item.owner_user_id === Number(owner)) || [...running.values()].some(item => item.owner === Number(owner))) throw mailError('当前用户已有邮件任务，请先完成或取消', 429);
    const occupied = new Set([...active.map(item => item.id), ...running.keys()]);
    if (occupied.size >= concurrency + maxQueue) throw mailError('邮件任务等待队列已满，请稍后重试', 429);
  }
  function scheduleTask(task, context) {
    contexts.set(task.id, context);
    if (!scheduled) { scheduled = true; setImmediate(() => { scheduled = false; drain(); }); }
  }
  function enqueue(task, context) { scheduleTask(task, context); return serialize(row(task.id), true, context); }
  function insert({ owner, kind, action = null, rule = null, spec = {}, paths = [], ready = false, format = 1, automatic = false }) {
    const id = crypto.randomBytes(18).toString('hex');
    db.prepare(`INSERT INTO mail_tasks(id,owner_user_id,kind,status,action,rule_id,rule_revision,spec_json,boundary_ready,resumable,created_at,snapshot_format,automatic)
      VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?)`).run(id, owner, kind, action, rule?.id ?? null, rule?.revision ?? null, JSON.stringify(spec), ready ? 1 : 0, kind === 'rule_preview' ? 0 : 1, now(), format, automatic ? 1 : 0);
    const add = db.prepare('INSERT INTO mail_task_folders(task_id,folder,ordinal) VALUES(?,?,?)');
    paths.forEach((folder, index) => add.run(id, folder, index));
    return row(id);
  }
  function createSeen(owner, paths, context) {
    return write(() => {
      admission(owner, context); prune(owner);
      if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FOLDERS || paths.some(folder => typeof folder !== 'string' || !folder || folder.length > 512 || /[\x00-\x1f\x7f]/.test(folder))) throw mailError('文件夹列表不合法');
      const selected = [...new Set(paths)]; selected.forEach(folder => authorize(context, folder));
      const task = db.transaction(() => insert({ owner, kind: 'seen_all', action: 'seen', paths: selected }))();
      return enqueue(task, context);
    });
  }
  function boundLabelAccount(context, folder, expected) {
    const account = resolveLabelAccount?.(context, folder, false);
    if (!account || (expected && Number(account.id) !== Number(expected))) throw mailError('邮件账号已变更或无法为此文件夹添加标签', 409);
    return account;
  }
  function labelSpec(rule, context) {
    if (rule.action !== 'label') return {};
    ownedLabel(db, context.user.id, rule.label_id);
    if (rule.folder) boundLabelAccount(context, rule.folder);
    return { labelId: rule.label_id };
  }
  function createPreview(owner, rule, context) {
    return write(() => {
      admission(owner, context); prune(owner);
      if (rule.folder) authorize(context, rule.folder);
      return enqueue(insert({ owner, kind: 'rule_preview', action: rule.action, rule,
        format: 2, spec: { scope: rule.scope, folder: rule.folder, filters: JSON.parse(rule.filters_json), ...labelSpec(rule, context) }, paths: rule.folder ? [rule.folder] : [] }), context);
    });
  }
  function pollAutomatic() {
    if (!automaticPreviews || closed || automaticPreviews.blocked() || maintenance.current()) return;
    const clock = now();
    try {
      const recoveryId = recoverableAutomatic[0]?.id;
      const recovered = recoveryId && row(recoveryId);
      if (recoveryId) {
        if (!recovered || recovered.automatic !== 2 || recovered.status !== 'interrupted' || isExpiredScan(recovered)) {
          if (recovered?.automatic === 2) saveTask(recovered.id, { automatic: 1 });
          recoverableAutomatic.shift();
        }
        else {
          const source = JSON.parse(recovered.spec_json).autoSource;
          const context = automaticPreviews.context(source);
          try {
            write(() => db.transaction(() => {
              admission(recovered.owner_user_id, context);
              saveTask(recovered.id, { automatic: 1, status: 'queued', phase: 'queued', error: null, finished_at: null });
            })());
            recoverableAutomatic.shift(); scheduleTask(recovered, context); return;
          } catch (error) {
            if (error.statusCode === 429) recoverableAutomatic.push(recoverableAutomatic.shift());
            else if ([401,403,404,409].includes(error.statusCode)) { if (automaticPreviews.revoked?.(error) || error.statusCode !== 409) { saveTask(recovered.id, { automatic: 1 }); recoverableAutomatic.shift(); } }
            else throw error;
          }
        }
      }
      if (!db.prepare('SELECT 1 FROM mail_auto_preview_pending WHERE ready_at<=? LIMIT 1').get(clock)) return;
      let queued;
      write(() => db.transaction(() => auto.takeNext(db, clock, automaticPreviews.localUser(), (rule, source) => {
        const context = automaticPreviews.context(source);
        admission(source.owner, context); prune(source.owner);
        if (rule.folder) authorize(context, rule.folder);
        const task = insert({ owner: source.owner, kind: 'rule_preview', action: rule.action, rule, format: 2, automatic: true,
          spec: { scope: rule.scope, folder: rule.folder, filters: JSON.parse(rule.filters_json), autoSource: source, ...labelSpec(rule, context) },
          paths: rule.folder ? [rule.folder] : [] });
        queued = { task, context };
      }))());
      if (queued) scheduleTask(queued.task, queued.context);
    } catch (error) {
      if (error.statusCode !== 409) automaticPreviews.onError?.(error);
    }
  }
  const automaticTimer = automaticPreviews && setInterval(pollAutomatic, auto.POLL_MS);
  automaticTimer?.unref?.();
  function ensureAutomaticAccount(source, context, folder) {
    if (!automaticPreviews || Number(context.user.id) !== source.owner
      || auto.currentAccount(db, source.owner, source.accountId, automaticPreviews.localUser(), folder).root !== source.root) {
      throw mailError('自动预览的账号已不可用', 409);
    }
  }
  function applyPreview(owner, rule, previewId, context) {
    return write(() => {
      authorize(context);
      const preview = owned(owner, previewId);
      if (preview.kind !== 'rule_preview' || preview.rule_id !== rule.id) throw mailError('规则预览不存在', 404);
      if (preview.application_task_id) return serialize(owned(owner, preview.application_task_id), true, context);
      admission(owner, context);
      if ((preview.status !== (preview.snapshot_format === 2 ? READY_SNAPSHOT : 'completed')) || preview.rule_revision !== rule.revision || !preview.expires_at || preview.expires_at <= now()) throw mailError('预览不完整、已过期或规则已修改，请重新预览', 409);
      const selected = folders(preview.id);
      if (selected.some(item => item.status !== 'completed')) throw mailError('预览不完整，请重新预览', 409);
      const autoSource = preview.automatic ? JSON.parse(preview.spec_json).autoSource : null;
      if (autoSource) {
        ensureAutomaticAccount(autoSource, context);
        auto.automaticScope(db, autoSource, automaticPreviews.localUser());
      }
      const spec = { ...labelSpec(rule, context), ...(autoSource ? { autoSource } : {}) };
      if (preview.action === 'label' && JSON.parse(preview.spec_json).labelId !== spec.labelId) throw mailError('规则已修改，请重新预览', 409);
      selected.forEach(item => {
        authorize(context, item.folder);
        if (autoSource) ensureAutomaticAccount(autoSource, context, item.folder);
        if (preview.action === 'label') boundLabelAccount(context, item.folder, item.label_account_id);
      });
      let task;
      db.transaction(() => {
        task = insert({ owner, kind: 'rule_apply', action: preview.action, rule, spec, ready: true, format: preview.snapshot_format });
        const add = db.prepare(`INSERT INTO mail_task_folders(task_id,folder,ordinal,uid_validity,upper_uid,uids_json,matched_count,label_account_id) VALUES(?,?,?,?,?,?,?,?)`);
        // Copy each completed frozen snapshot once. Keep the legacy JSON for
        // application rollback compatibility, but never parse it per new batch.
        const blocks = db.prepare('SELECT uids_json FROM mail_task_uid_blocks WHERE task_id=? AND folder=? ORDER BY position');
        for (const item of selected) {
          const frozen = preview.snapshot_format === 2 ? blocks.all(preview.id, item.folder).flatMap(block => JSON.parse(block.uids_json)) : JSON.parse(item.uids_json);
          if (frozen.length !== item.matched_count || frozen.some((uid, i) => !Number.isInteger(uid) || uid < 1 || uid > item.upper_uid || (i > 0 && frozen[i - 1] <= uid))) {
            throw mailError('预览不完整，请重新预览', 409);
          }
          add.run(task.id, item.folder, item.ordinal, item.uid_validity, item.upper_uid, JSON.stringify(frozen), frozen.length, item.label_account_id);
        }
        if (preview.snapshot_format === 2) db.prepare(`INSERT INTO mail_task_uid_blocks(task_id,folder,position,uids_json)
          SELECT ?,folder,position,uids_json FROM mail_task_uid_blocks WHERE task_id=?`).run(task.id, preview.id);
        saveTask(preview.id, { application_task_id: task.id });
      })();
      return enqueue(task, context);
    });
  }
  function guard(task, context, signal, folder) {
    if (signal.aborted || closed) throw signal.reason || mailError('任务已中断', 499);
    if (isExpiredScan(task)) throw mailError('预览已过期，请重新预览', 410);
    if (maintenance.current() === 'restore') throw mailError('系统正在恢复，任务已中断', 409);
    authorize(context, folder);
    if (task.kind === 'rule_apply' && task.automaticScope === undefined) task.automaticScope = JSON.parse(task.spec_json).autoSource || null;
    if (task.automaticScope) ensureAutomaticAccount(task.automaticScope, context, folder);
  }
  async function open(task, context, signal, folder, readOnly, work, timeoutMs) {
    guard(task, context, signal, folder);
    return withFolder(context, folder, readOnly, signal, async (client, mailbox, ensureActive) => {
      const check = () => { ensureActive(); guard(task, context, signal, folder); };
      check();
      const item = folderRow(task.id, folder);
      if (task.action === 'label') boundLabelAccount(context, folder, item.label_account_id);
      const validity = String(mailbox.uidValidity || '');
      if (!validity || (item.uid_validity && item.uid_validity !== validity)) {
        saveTask(task.id, { resumable: 0 });
        throw mailError('文件夹 UIDVALIDITY 已变化，请重新选择范围创建任务', 409);
      }
      return work(client, mailbox, check, item);
    }, timeoutMs);
  }
  async function initialize(task, context, signal) {
    if (task.boundary_ready) {
      for (const item of folders(task.id)) {
        if (task.kind === 'rule_preview') guard(task, context, signal, item.folder);
        else await open(task, context, signal, item.folder, true, async () => {});
      }
      return true;
    }
    const preview = isBlockPreview(task);
    if (preview && !task.preview_scope_ready) {
      const spec = JSON.parse(task.spec_json);
      let paths = spec.scope === 'folder' ? [spec.folder] : await listFolders(context, signal);
      if (task.action === 'label') paths = paths.filter(folder => resolveLabelAccount?.(context, folder, false));
      guard(task, context, signal);
      if (paths.length > MAX_FOLDERS) throw mailError('预览超过500个文件夹，请收紧范围', 413);
      db.transaction(() => {
        // Trust only a directory list committed with its marker. Older interrupted
        // previews may have persisted an incomplete list before this migration.
        db.prepare('DELETE FROM mail_task_folders WHERE task_id=?').run(task.id);
        const add = db.prepare('INSERT INTO mail_task_folders(task_id,folder,ordinal) VALUES(?,?,?)');
        [...new Set(paths)].forEach((folder, index) => add.run(task.id, folder, index));
        saveTask(task.id, { preview_scope_ready: 1, resumable: 1 });
      })();
      task.preview_scope_ready = 1;
    }
    // Freeze every directory before any scanning or writes. For previews, keep
    // previously frozen UID ceilings across a temporary failure or restart.
    let incomplete = false;
    for (const item of folders(task.id)) {
      if (preview) {
        guard(task, context, signal, item.folder);
        if (item.uid_validity && item.upper_uid !== null) continue;
        saveTask(task.id, { current_folder: item.folder });
      }
      try {
        await open(task, context, signal, item.folder, true, async (client, mailbox, check) => {
          let upper = Number(mailbox.uidNext) - 1;
          if (!Number.isSafeInteger(upper) || upper < 0 || upper > 4294967295) {
            const last = await newestUids(client, { all: true }, mailbox, null, 1, check); check(); upper = last[0] || 0;
          }
          check(); saveFolder(task.id, item.folder, {
            ...(task.action === 'label' ? { label_account_id: boundLabelAccount(context, item.folder).id } : {}),
            uid_validity: String(mailbox.uidValidity), upper_uid: upper, before_uid: upper + 1,
            status: 'pending', error: null });
        });
      } catch (error) {
        if (!preview || isTerminalTaskError(error, signal)) throw error;
        incomplete = true;
        saveFolder(task.id, item.folder, { status: 'failed', error: '文件夹搜索或加载失败' });
      }
    }
    guard(task, context, signal);
    if (incomplete) return false;
    saveTask(task.id, { boundary_ready: 1 }); task.boundary_ready = 1;
    return true;
  }
  async function verifyLabelAndWrite(task, item, client, check, context) {
    const pending = JSON.parse(item.pending_json);
    const fetched = await client.fetchAll(pending, { uid: true }, { uid: true }); check();
    if (!Array.isArray(fetched)) throw mailError('无法确认邮件标签，请稍后重试', 502);
    const present = new Set(fetched.map(message => message.uid));
    const confirmed = pending.filter(uid => present.has(uid));
    const { labelId } = JSON.parse(task.spec_json);
    write(() => db.transaction(() => {
      check();
      const account = boundLabelAccount(context, item.folder, item.label_account_id);
      addBindings(db, labelId, task.owner_user_id, account.id, item.folder, item.uid_validity, confirmed);
      saveFolder(task.id, item.folder, { pending_json: '[]', confirmed: item.confirmed + confirmed.length,
        missing: item.missing + pending.length - confirmed.length, cursor: item.next_cursor });
    })());
  }
  async function verifyAndWrite(task, item, client, check) {
    const [flag, add] = ACTIONS[task.action];
    async function confirm() {
      const current = folderRow(task.id, item.folder);
      const pending = JSON.parse(current.pending_json);
      if (!pending.length) return [];
      const fetched = await client.fetchAll(pending, { uid: true, flags: true }, { uid: true }); check();
      if (!Array.isArray(fetched)) throw mailError('无法确认邮件标记，结果待核实', 502);
      if (fetched.some(value => pending.includes(value.uid) && !(value.flags instanceof Set))) throw mailError('无法确认邮件标记，结果待核实', 502);
      const actual = new Map(fetched.filter(value => pending.includes(value.uid) && value.flags instanceof Set).map(value => [value.uid, value.flags]));
      const remaining = pending.filter(uid => actual.has(uid) && actual.get(uid).has(flag) !== add);
      const confirmed = pending.filter(uid => actual.has(uid) && actual.get(uid).has(flag) === add).length;
      const missing = pending.filter(uid => !actual.has(uid)).length;
      check(); saveFolder(task.id, item.folder, { pending_json: JSON.stringify(remaining), confirmed: current.confirmed + confirmed,
        missing: current.missing + missing, ...(remaining.length ? {} : task.kind === 'seen_all' ? { before_uid: current.next_cursor } : { cursor: current.next_cursor }) });
      return remaining;
    }
    // This also reconciles a command submitted before cancellation or a crash.
    let remaining = await confirm();
    if (!remaining.length) return;
    check();
    const ok = await client[add ? 'messageFlagsAdd' : 'messageFlagsRemove'](remaining, [flag], { uid: true }); check();
    if (!ok) throw mailError('邮件标记未确认，结果待核实', 502);
    remaining = await confirm();
    if (remaining.length) throw mailError('部分邮件标记未确认，结果待核实', 502);
  }
  async function previewBatch(task, item, context, client, mailbox, check, criteria) {
    check();
    if (task.action === 'label') boundLabelAccount(context, item.folder, item.label_account_id);
    if (item.scan_batches >= MAX_SCAN_BATCHES_PER_FOLDER) throw mailError('预览达到扫描上限，请收紧条件', 413);
    const result = item.upper_uid ? await scanUids(client, criteria, mailbox, item.before_uid, BATCH_SIZE, check)
      : { exhausted: true, uids: [] };
    check();
    const { exhausted, nextBeforeUid, uids } = result;
    if (uids.length > BATCH_SIZE || uids.some((uid, i) => !Number.isInteger(uid) || uid < 1 || uid > item.upper_uid || uid >= item.before_uid || (i > 0 && uids[i - 1] <= uid))
      || (!exhausted && (!Number.isInteger(nextBeforeUid) || nextBeforeUid < 1 || nextBeforeUid >= item.before_uid || (uids.length && nextBeforeUid > uids.at(-1))))) {
      throw mailError('预览扫描位置无效，请重新预览', 409);
    }
    let samples = JSON.parse(item.samples_json), sampleReason = item.sample_reason;
    // At most one small, header-only request per folder. This is decorative;
    // a temporary header fetch failure cannot change the frozen match set.
    if (!item.matched_count && uids.length && typeof client.fetchAll === 'function') {
      const sampleUids = uids.slice(0, PREVIEW_SAMPLE_SIZE);
      try {
        const headers = await client.fetchAll(sampleUids, { uid: true, envelope: true, internalDate: true }, { uid: true });
        const selected = new Map(headers.map(message => [message.uid, message]));
        samples = sampleUids.filter(uid => selected.has(uid)).map(uid => {
          const message = selected.get(uid);
          const date = new Date(message.internalDate || message.envelope?.date || NaN);
          return { subject: utf8Prefix(String(message.envelope?.subject || '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' '), 192),
            date: Number.isFinite(date.getTime()) ? date.toISOString() : null };
        });
        if (samples.length < sampleUids.length) sampleReason = 'removed';
      } catch { sampleReason = 'unavailable'; }
      check();
    }
    if (task.action === 'label') boundLabelAccount(context, item.folder, item.label_account_id);
    db.transaction(() => {
      const total = db.prepare('SELECT COALESCE(SUM(matched_count),0) AS n FROM mail_task_folders WHERE task_id=?').get(task.id).n;
      if (total + uids.length > MAX_PREVIEW_MATCHES) throw mailError('预览超过50000封匹配邮件，请收紧条件', 413);
      if (uids.length) db.prepare('INSERT INTO mail_task_uid_blocks(task_id,folder,position,uids_json) VALUES(?,?,?,?)')
        .run(task.id, item.folder, item.matched_count, JSON.stringify(uids));
      saveFolder(task.id, item.folder, { matched_count: item.matched_count + uids.length,
        scan_batches: item.scan_batches + 1, before_uid: exhausted ? 1 : nextBeforeUid,
        samples_json: JSON.stringify(samples), sample_reason: sampleReason,
        status: exhausted ? 'completed' : 'pending', error: null });
    })();
    return exhausted;
  }
  async function previewFolder(task, folder, context, signal) {
    const criteria = searchCriteria(JSON.parse(task.spec_json).filters);
    for (;;) {
      const exhausted = await open(task, context, signal, folder, true, async (client, mailbox, check, initial) => {
        const started = monotonicNow();
        const path = mailbox.path;
        const verify = () => {
          check();
          // ImapFlow may clear or replace the selected mailbox during a connection.
          const selected = client.mailbox === undefined ? mailbox : client.mailbox;
          if (!selected) throw mailError('邮箱连接中断，请稍后重试', 502);
          if (String(selected.uidValidity || '') !== initial.uid_validity ||
              (path !== undefined && selected.path !== path)) {
            saveTask(task.id, { resumable: 0 });
            throw mailError('文件夹 UIDVALIDITY 已变化，请重新选择范围创建任务', 409);
          }
        };
        for (let batch = 0; batch < PREVIEW_BATCHES_PER_CONNECTION; batch++) {
          if (batch && monotonicNow() - started >= PREVIEW_CONNECTION_SOFT_MS) break;
          const item = batch ? folderRow(task.id, folder) : initial;
          if (await previewBatch(task, item, context, client, mailbox, verify, criteria)) return true;
          if (batch + 1 < PREVIEW_BATCHES_PER_CONNECTION && monotonicNow() - started < PREVIEW_CONNECTION_SOFT_MS) {
            // Give other work a turn even while this folder connection is open.
            await new Promise(resolve => setImmediate(resolve));
          }
        }
        return false;
      }, 45_000);
      if (exhausted) break;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  async function processFolder(task, original, context, signal) {
    if (task.kind === 'rule_preview') return previewFolder(task, original.folder, context, signal);
    await open(task, context, signal, original.folder, task.action === 'label', async (client, mailbox, check) => {
      for (;;) {
        check(); let item = folderRow(task.id, original.folder);
        if (!JSON.parse(item.pending_json).length) {
          let batch, next;
          if (task.kind === 'seen_all') {
            if (!item.upper_uid || item.before_uid <= 1) break;
            const { uids, nextBeforeUid, exhausted } = await scanUids(client, { seen: false }, mailbox, item.before_uid, BATCH_SIZE, check);
            check();
            next = exhausted ? 1 : nextBeforeUid;
            if (!Number.isInteger(next) || next < 1 || next >= item.before_uid || uids.length > BATCH_SIZE
                || uids.some((uid, i) => !Number.isInteger(uid) || uid < next || uid >= item.before_uid || (i && uids[i - 1] <= uid))) {
              throw mailError('标读扫描位置无效，请重试', 409);
            }
            if (!uids.length) {
              saveFolder(task.id, item.folder, { before_uid: next });
              if (exhausted) break;
              await new Promise(resolve => setImmediate(resolve));
              continue;
            }
            batch = uids;
          } else {
            batch = task.snapshot_format === 2
              ? JSON.parse(db.prepare('SELECT uids_json FROM mail_task_uid_blocks WHERE task_id=? AND folder=? AND position=?').get(task.id, item.folder, item.cursor)?.uids_json || '[]')
              : JSON.parse(item.uids_json).slice(item.cursor, item.cursor + BATCH_SIZE);
            if (!batch.length) {
              if (item.cursor < item.matched_count) throw mailError('预览快照不完整，请重新预览', 409);
              break;
            }
            next = item.cursor + batch.length;
          }
          check();
          saveFolder(task.id, item.folder, { pending_json: JSON.stringify(batch), next_cursor: next });
          item = folderRow(task.id, original.folder);
        }
        if (task.action === 'label') await verifyLabelAndWrite(task, item, client, check, context);
        else await verifyAndWrite(task, item, client, check);
        check();
        // Yield between batches so cancellation and other users can advance.
        await new Promise(resolve => setImmediate(resolve));
      }
      check(); saveFolder(task.id, original.folder, { status: 'completed', error: null });
    });
  }
  async function run(task, context, controller) {
    const { signal } = controller;
    saveTask(task.id, { status: 'running', phase: 'checking_scope', finished_at: null, error: null });
    const watch = setInterval(() => {
      try { guard(task, context, signal, row(task.id)?.current_folder); }
      catch (error) { if (!signal.aborted) controller.abort(error); }
    }, 250); watch.unref?.();
    try {
      if (!await initialize(task, context, signal)) {
        saveTask(task.id, { status: 'partial' });
        return;
      }
      guard(task, context, signal);
      saveTask(task.id, { phase: 'processing' });
      for (const item of folders(task.id)) {
        if (item.status === 'completed') continue;
        guard(task, context, signal, item.folder); saveTask(task.id, { current_folder: item.folder });
        try { await processFolder(task, item, context, signal); }
        catch (error) {
          if (isTerminalTaskError(error, signal)) throw error;
          const message = task.kind === 'rule_preview' ? '文件夹搜索或加载失败' : '处理未完成；未确认的标记将在继续前核对';
          saveFolder(task.id, item.folder, { status: 'failed', error: message });
        }
      }
      guard(task, context, signal);
      const incomplete = folders(task.id).some(item => item.status !== 'completed' || item.missing);
      if (task.kind === 'rule_preview' && !incomplete) {
        for (const item of folders(task.id)) await open(task, context, signal, item.folder, true, async () => {});
        guard(task, context, signal);
      }
      saveTask(task.id, { status: incomplete ? 'partial' : task.kind === 'rule_preview' ? READY_SNAPSHOT : 'completed',
        expires_at: task.kind === 'rule_preview' && !incomplete ? now() + PREVIEW_TTL : null,
        resumable: folders(task.id).some(item => item.status !== 'completed') ? 1 : 0 });
    } catch (error) {
      const latest = row(task.id);
      if (latest) saveTask(task.id, { status: latest.status === 'invalidated' ? 'invalidated' : signal.aborted && signal.reason?.cancelled ? 'cancelled' : 'interrupted',
        error: error.statusCode ? error.message : hasResumeScope(latest) ? '任务未完成，请检查连接后继续' : '范围快照未完成，请重新选择范围创建任务',
        resumable: latest.resumable && hasResumeScope(latest) && (task.kind !== 'rule_preview' ||
          (!signal.reason?.cancelled && ![401, 403, 404, 410, 413].includes(error.statusCode))) ? 1 : 0 });
    } finally {
      clearInterval(watch);
      if (row(task.id)) saveTask(task.id, { finished_at: now(), current_folder: null, phase: null });
      contexts.delete(task.id); running.delete(task.id); drain();
    }
  }
  function drain() {
    if (closed || maintenance.current() === 'restore') return;
    for (const task of db.prepare("SELECT * FROM mail_tasks WHERE status='queued' ORDER BY created_at,id").all()) {
      if (running.size >= concurrency) break;
      if ([...running.values()].some(item => item.owner === task.owner_user_id)) continue;
      const context = contexts.get(task.id);
      if (!context) { saveTask(task.id, { status: 'interrupted', finished_at: now() }); continue; }
      const controller = new AbortController();
      const entry = { controller, promise: null, owner: task.owner_user_id }; running.set(task.id, entry);
      entry.promise = run(task, context, controller).catch(() => {});
    }
  }
  function cancel(owner, id, context) {
    const task = owned(owner, id);
    if (ACTIVE.includes(task.status)) {
      const entry = running.get(id);
      if (entry) { saveTask(id, { status: 'cancelling' }); entry.controller.abort(Object.assign(mailError('任务已取消；已提交命令的结果待核实', 499), { cancelled: true })); }
      else { saveTask(id, { status: 'cancelled', finished_at: now(), resumable: task.boundary_ready && task.kind !== 'rule_preview' ? task.resumable : 0 }); contexts.delete(id); }
    }
    return serialize(row(id), true, context);
  }
  async function resume(owner, id, context) {
    return write(() => {
      const task = owned(owner, id);
      admission(owner, context);
      if (task.automatic || !task.resumable || !hasResumeScope(task) || ['completed', READY_SNAPSHOT, 'invalidated'].includes(task.status) || isExpiredScan(task)) {
        throw mailError('该任务不能继续，请重新选择范围', 409);
      }
      if (task.kind === 'rule_preview') {
        const rule = db.prepare('SELECT revision FROM mail_rules WHERE owner_user_id=? AND id=?').get(owner, task.rule_id);
        if (!rule || rule.revision !== task.rule_revision) throw mailError('规则已修改，请重新预览', 409);
      }
      saveTask(id, { status: 'queued', phase: 'queued', error: null, finished_at: null });
      // The worker checks all frozen folders once, under its cancellable slot.
      return enqueue(task, context);
    });
  }
  async function interruptAll() {
    for (const task of db.prepare("SELECT id FROM mail_tasks WHERE status='queued'").all()) {
      saveTask(task.id, { status: 'interrupted', finished_at: now(), error: '任务已因维护中断，请手动继续' }); contexts.delete(task.id);
    }
    const entries = [...running.values()];
    entries.forEach(entry => entry.controller.abort(mailError('任务已因维护中断', 409)));
    await Promise.all(entries.map(entry => entry.promise));
  }
  function invalidateRule(owner, ruleId) {
    for (const task of db.prepare("SELECT * FROM mail_tasks WHERE owner_user_id=? AND rule_id=? AND kind='rule_preview' AND application_task_id IS NULL").all(owner, ruleId)) {
      cancel(owner, task.id); saveTask(task.id, { status: 'invalidated', resumable: 0, expires_at: null, error: '规则已修改，请重新预览' });
    }
  }
  return { createSeen, createPreview, pollAutomatic, applyPreview, resume, cancel, interruptAll, invalidateRule,
    status() {
      const queued = db.prepare("SELECT COUNT(*) AS n FROM mail_tasks WHERE status='queued'").get().n;
      const phases = db.prepare("SELECT phase,COUNT(*) AS n FROM mail_tasks WHERE status IN ('running','cancelling') GROUP BY phase").all();
      return { running: running.size, queued, concurrency, maxQueue, checkingScope: phases.find(row => row.phase === 'checking_scope')?.n || 0 };
    },
    get(owner, id, context) { return serialize(owned(owner, id), true, context); },
    getActive(owner, kind = null) { const task = db.prepare("SELECT * FROM mail_tasks WHERE owner_user_id=? AND (? IS NULL OR kind=?) AND status IN ('queued','running','cancelling') ORDER BY created_at LIMIT 1").get(owner, kind, kind); return task ? serialize(task) : null; },
    list(owner, page = 1, pageSize = 20) {
      prune(owner); pageSize = Math.max(1, Math.min(50, Math.floor(Number(pageSize)) || 20));
      const total = db.prepare('SELECT COUNT(*) AS n FROM mail_tasks WHERE owner_user_id=?').get(owner).n;
      const totalPages = Math.max(1, Math.ceil(total / pageSize)); page = Math.max(1, Math.min(totalPages, Math.floor(Number(page)) || 1));
      return { items: db.prepare('SELECT * FROM mail_tasks WHERE owner_user_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(owner, pageSize, (page - 1) * pageSize).map(task => serialize(task, false)), pagination: { page, pageSize, total, totalPages } };
    },
    async close() {
      closed = true;
      if (automaticTimer) clearInterval(automaticTimer);
      if (maintenance.current() !== 'restore') db.prepare("UPDATE mail_tasks SET automatic=2 WHERE automatic=1 AND status IN ('queued','running')").run();
      await interruptAll();
    },
  };
}
module.exports = { initializeMailTasks, createMailTaskService, ACTIONS, BATCH_SIZE, MAX_FOLDERS, MAX_PREVIEW_MATCHES, PREVIEW_TTL };
