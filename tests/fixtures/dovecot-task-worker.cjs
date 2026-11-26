'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const { ImapFlow } = require('imapflow');
const { createMailRouter } = require('../../server/mail-reader');
const [filename, folder, mode] = process.argv.slice(2);
const port = Number(process.env.MAIL_TEST_IMAP_PORT);
if (process.env.MAIL_TEST_IMAP_ALLOW_WRITE !== 'synthetic-only' || !Number.isInteger(port) || port < 1024 ||
    !/^CodexCrash[A-Fa-f0-9]+$/.test(folder)) throw new Error('Requires the isolated test fixture');

const db = new Database(filename);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO admin_users VALUES(1)');
const router = createMailRouter({ taskDb: db, mailAccessForRequest: () => ({ all: false, roots: [folder] }),
  createClient() {
    const imap = new ImapFlow({ host: '127.0.0.1', port, secure: false, doSTARTTLS: false, logger: false, disableAutoIdle: true,
      auth: { user: process.env.MAIL_TEST_IMAP_USER, pass: process.env.MAIL_TEST_IMAP_PASSWORD } });
    imap.on('error', () => {});
    const add = imap.messageFlagsAdd.bind(imap);
    imap.messageFlagsAdd = async (...args) => {
      const changed = await add(...args);
      process.send({ wrote: changed });
      if (mode === 'pause-after-store') await new Promise(() => {});
      return changed;
    };
    return imap;
  },
});
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
app.use(router);
void router.mailTasks;
const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async value => {
  if (value !== 'stop') return;
  await router.mailTasks.close();
  server.closeAllConnections();
  server.close(() => { db.close(); process.disconnect(); });
});
