'use strict';

// The trigger runs in the same transaction as the restore commit marker. A
// timestamp is only evidence of a terminal result once the journal is gone.
function migrateRestoreNotificationSource(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_state'").get()) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS restore_notification_source (
      operation_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_restore_notification_at ON restore_notification_source(at,operation_id);
    CREATE TRIGGER IF NOT EXISTS capture_restore_notification_insert AFTER INSERT ON restore_state
      WHEN NEW.outcome IN ('committed','recovered_committed','rolled_back')
      BEGIN INSERT INTO restore_notification_source(operation_id,outcome,at)
        VALUES(NEW.operation_id,NEW.outcome,NEW.recorded_at) ON CONFLICT(operation_id) DO NOTHING; END;
    CREATE TRIGGER IF NOT EXISTS capture_restore_notification_update AFTER UPDATE ON restore_state
      WHEN NEW.outcome IN ('committed','recovered_committed','rolled_back')
      BEGIN INSERT INTO restore_notification_source(operation_id,outcome,at)
        VALUES(NEW.operation_id,NEW.outcome,NEW.recorded_at) ON CONFLICT(operation_id) DO NOTHING; END;
    INSERT OR IGNORE INTO restore_notification_source(operation_id,outcome,at)
      SELECT operation_id,outcome,recorded_at FROM restore_state WHERE outcome IN ('committed','recovered_committed','rolled_back');
  `);
}

module.exports = { migrateRestoreNotificationSource };
