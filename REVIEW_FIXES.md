# Review fixes (unreleased)

The repair stage addresses the sixteen findings from the 2026-10-28 review.
Subsequent work adds folder search, attachment downloads and EML export, as
documented in MAIL_FEATURES.md. The separate Maildir encryption/rehearsal tool
added later is documented in MAILDIR_BACKUP.md; the original application backup
still excludes Maildir. Outbound mail remains out of scope.

## 2026-11-07 follow-up review

This pass reproduced and repaired two gaps missed by the existing suite:
retrying a failed second page requested page three, and an aborted ordinary
folder search could still fetch message summaries after its search completed.
It also added coverage and fixes for:

- Late read-state responses from an old UIDVALIDITY affecting the newly rebuilt
  mailbox's UI.
- Empty folder refreshes leaving the previous message list and reader visible.
- Already disconnected requests creating a client before cancellation handling.
- Archive expansion limits counting only file contents. Both backup validators
  now bound the entire decompressed tar stream, including metadata and padding;
  application restore applies its own lower limit before extraction.

See MAIL_ROADMAP.md for the updated order of release validation and further work.

## Behavior changes

| Finding | Change |
| --- | --- |
| F01 | Account editing rejects flat mode for isolated accounts; runtime also rejects corrupted isolated mappings and non-primary legacy flat accounts. Editing is blocked while an account is active. |
| F02 | imapsync and its OAuth refresh child receive the absolute service data directory. |
| F03 | Updated compatible dependencies and pinned mailparser/sanitize-html; compressed JSON request bodies are rejected. |
| F04 | Restored credentials inherit the trusted live secret directory's uid/gid recursively before replacement. |
| F05 | A cross-process state lock protects configuration mutations, OAuth refresh, backup and restore. It stays held across asynchronous work. |
| F06 | Connection tests reserve capacity before DNS and share the sync limit; shutdown waits for test children and pending preparation. |
| F07 | imapsync connects to the checked numeric source address while verifying the original hostname and using it for TLS SNI. |
| F08 | Target probes use ImapFlow TLS policy; off-host imapsync target connections explicitly require verified TLS/STARTTLS. |
| F09 | Check app/cache/tmp storage plus the actual Maildir filesystem and free inodes via a fixed helper operation. Unknown capacity blocks new work. |
| F10 | Preparation and completion errors are caught; locks/waiters are released; database failure pauses the queue. Async mutating routes forward errors. |
| F11 | New passwords are at least 10 characters and at most 72 UTF-8 bytes. Existing password verification remains compatible. |
| F12 | Mail pagination uses UID cursors and rejects a changed UIDVALIDITY. |
| F13 | OpenRC no longer silently replaces the persisted Web port; an explicit PORT override rejects ineffective UI changes. |
| F14 | apt-based platforms install sqlite3, Alpine installs sqlite. |
| F15 | CI checks each shell file individually, including the OpenRC service file. |
| F16 | Restore merges ownership of deleted accounts, maps known owners by username, and retains inaccessible tombstones for unknown owners. Conflicts fail closed. |

The production-driver smoke test also exposed and fixed a restore failure:
better-sqlite3 does not permit updating ownership while an iterator on that
same connection is active. Restore now materializes the account list first.

## Upgrade notes

- Deploy the updated application **and** Dovecot helper/sudoers rule together.
  The new `storage-status <username>` operation reads only capacity/inodes for
  `/home/<validated-username>/Maildir`; it does not disclose mail contents or
  accept arbitrary paths. Old helpers fail closed until upgraded.
- For a custom Maildir location or remotely mounted target storage, set
  `MAIL_AGG_MAIL_STORAGE_PATH` to the actual target filesystem path that the
  application can inspect. It must represent the mail storage, not a convenient
  unrelated local directory. A remote server without an inspectable mount is
  intentionally not treated as having verified free disk space.
- The new state lock is `<data-dir>/.state-write.lock`. Concurrent changes return
  HTTP 409; CLI OAuth refresh waits up to 30 seconds. After a crash, stop the
  application and all backup/restore/OAuth processes, inspect the lock's PID and
  timestamp, and remove only that stale lock before restart. Never delete a live
  lock. Automatic PID-based lock stealing is deliberately avoided because of
  PID reuse and long-running operations.
- The standard persisted `web_port` now controls both OpenRC and systemd. An
  operator-provided `PORT` still takes precedence and must be changed outside
  the Web UI. Reload the browser after upgrading to get the UID pagination UI.
- Existing bcrypt passwords over 72 bytes still verify with their original
  behavior. Users should change them to a compliant new password. This patch
  does not pretend to recover the discarded suffix of an existing hash.
- Numeric source address pinning may use a different imapsync cache namespace
  than a previous hostname-based run. Use a non-destructive test account to
  verify cache behavior and incremental copying with the deployed imapsync
  version before enabling mirror deletion on important mail.

## Verification

Run `npm ci`, `npm test`, `npm run test:integration`, and
`npm audit --omit=dev --audit-level=high`. The integration smoke test starts the
real application with the production SQLite driver and isolated temporary data,
then checks auth, account isolation, port override, tar backup, inspection and
restore. It never starts a real source sync. CI runs it on both supported Node
matrix versions.

Linux installation, root ownership after restore, real Dovecot/imapsync TLS,
OAuth provider authorization, and incremental cache behavior still require the
deployment acceptance checks in TESTING.md. Windows simulations are not a
substitute for those checks. Broader architecture recommendations in the review
(storage-level tenant isolation, 2FA and observability) remain separate work.
Encrypted Maildir backup and asynchronous password hashing now have local
implementations; their deployment acceptance boundaries are documented separately.

Protocol references: [imapsync SSL argument handling](https://github.com/imapsync/imapsync),
[IO::Socket::SSL hostname verification and SNI](https://metacpan.org/pod/IO::Socket::SSL).

## 2026-11-14 responsiveness changes

- Replaced main-thread bcrypt in all Web authentication and user-management
  paths with a shared, bounded worker pool. Queue overflow, worker failure and
  a deadline covering queue time fail with HTTP 503. Password format and cost
  remain compatible with existing hashes.
- Removed the configuration lock from expensive password work. Revalidate
  enabled status, roles, session versions, password snapshots and login limits
  after awaiting results and before issuing sessions or committing changes.
  Pending attempts count toward per-username/IP admission limits. Recheck the
  persisted session after awaiting work; logout revokes pending actions and a
  late response cannot recreate the destroyed session.
- Replaced synchronous statfs/helper execution with bounded asynchronous
  probes shared by sync admission, running syncs and health reports. Cache raw
  observations briefly, re-read the reserve, and never use expired successes on
  errors. Fail closed on timeout, capacity uncertainty and exhausted inodes.
- Reserve sync slots before waiting, revalidate owner and target configuration,
  support cancellation during preparation, suppress overlapping periodic checks
  and ignore late results after completion. Coalesce scheduler ticks and check
  its stop generation before enqueueing.
- Added deterministic concurrency/failure regressions and production SQLite/HTTP
  checks. The synthetic benchmark now exercises the actual production pool and
  capacity checker; results and Linux acceptance gaps are in RESPONSIVENESS.md.
