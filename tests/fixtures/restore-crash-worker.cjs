'use strict';

const fs = require('node:fs');
const path = require('node:path');
const native = process.env.MAIL_TEST_NATIVE_SQLITE === '1';
const Database = native ? require('better-sqlite3') : require('node:sqlite').DatabaseSync;
const { restoreApplicationState } = require('../../server/restore');
const [root, checkpoint] = process.argv.slice(2);
const release = native ? require('../../server/data-process').acquireDataProcessLock(root) : () => {};

function pauseAt(name) {
  if (name !== checkpoint) return;
  fs.writeSync(1, `checkpoint ${name}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  rename(source, destination);
  if (path.basename(destination) === '.restore-journal.json') pauseAt('journal');
  if (path.basename(destination) === 'old') pauseAt('old-moved');
  if (path.basename(source) === 'next') pauseAt('new-live');
};

const remove = fs.rmSync;
fs.rmSync = (target, options) => {
  remove(target, options);
  if (/^\.restore-secrets-/.test(path.basename(target))) pauseAt('stage-cleaned');
};

const unlink = fs.unlinkSync;
fs.unlinkSync = filename => {
  unlink(filename);
  if (path.basename(String(filename)) === '.state-write.lock') pauseAt('lock-released');
  if (path.basename(String(filename)) === '.restore-journal.json') pauseAt('journal-retired');
};

const current = new Database(path.join(root, 'db', 'mail-aggregator.db'));
current.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
const transaction = native ? current.transaction.bind(current) : callback => () => {
  current.exec('BEGIN');
  let result;
  try { result = callback(); current.exec('COMMIT'); }
  catch (error) { current.exec('ROLLBACK'); throw error; }
  return result;
};
current.transaction = callback => {
  const commit = transaction(callback);
  return () => {
    const result = commit();
    pauseAt('committed');
    return result;
  };
};

restoreApplicationState({ Database, currentDb: current, backupDbPath: path.join(root, 'source.db'),
  currentSecretsDir: path.join(root, 'secrets'), backupSecretsDir: path.join(root, 'source-secrets') });
current.close();
release();
