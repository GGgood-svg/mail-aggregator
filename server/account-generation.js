'use strict';

const { lastRestoreResult } = require('./restore-journal');
const initialized = new WeakSet();

function initialize(database) {
  if (initialized.has(database)) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_config_generations (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      generation TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS account_config_generation_create AFTER INSERT ON accounts BEGIN
      INSERT OR REPLACE INTO account_config_generations(account_id,generation) VALUES(NEW.id,lower(hex(randomblob(16))));
    END;
    CREATE TRIGGER IF NOT EXISTS account_config_generation_update AFTER UPDATE OF
      name,provider,host,port,ssl,username,auth_type,enabled,sync_interval,local_user,sync_mode,
      destination_mode,destination_folder,mailbox_folder,folder_includes,folder_excludes,
      max_age_days,max_size_mb,deletion_mode,owner_user_id ON accounts BEGIN
      INSERT OR REPLACE INTO account_config_generations(account_id,generation) VALUES(NEW.id,lower(hex(randomblob(16))));
    END;
  `);
  initialized.add(database);
}

function accountGeneration(database, accountId) {
  initialize(database);
  return JSON.stringify([
    database.prepare('SELECT generation FROM account_config_generations WHERE account_id=?').get(accountId)?.generation || null,
    lastRestoreResult(database)?.operation_id || null,
  ]);
}

module.exports = { accountGeneration };
