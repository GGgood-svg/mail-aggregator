# Changelog

## Unreleased

- Scope login throttling by normalized client address and username, enforce a real failure window, and reject reverse-proxy login traffic that omits the configured forwarded client address.
- Apply the same bounded password-attempt policy to authenticated password changes, backup exports, restores, and uninstall confirmations.
- Bound imapsync output retained in memory and cap each task log (configurable, 16 MB by default) while preserving its beginning, diagnostic tail, and complete streamed counters.
- Add configurable per-user account quotas and a fail-closed free-disk reserve that blocks new sync work and terminates running jobs if the server filesystem approaches exhaustion.
- Make mailbox access fail closed without an authenticated identity, create service logs as `0600`, and report unsafe service-log permissions in `doctor.sh`.
- Deploy upgrades through a fully prepared staging tree so deleted release files cannot survive and a failed dependency install cannot damage the live application.
- Make app-only upgrades install the exact lockfile dependency tree and restart the Web service; startup failures now stop the installer instead of ending with a false success message.
- Preserve executable bits for command-line shell scripts and force OpenRC service files to LF endings so GitHub archives install correctly on Linux even when created from Windows.
- Roll back account database rows, mailbox ownership, and credential files when account creation or editing fails partway through.
- Enforce a private runtime umask and repair existing data/database/session/log permissions; quote installer IMAP login credentials correctly when passwords contain spaces or punctuation.
- Fix privileged Dovecot helper paths so an unprivileged sudo caller cannot redirect password operations through environment variables.
- Remove the default Express technology banner from HTTP responses.
- Validate notification Webhook URLs and pin HTTPS connections to DNS answers that pass the public-address policy, preventing private-network and metadata-service requests.
- Update Express within the supported major line and pin mailparser at the last Node.js 18-compatible build so Debian 12 installations are not silently upgraded to an incompatible runtime requirement.
- Reject unsupported pre-18 Node.js installations before deployment instead of relying on an npm engine warning and producing a service that cannot start.
- Use an equal-cost bcrypt check for unknown usernames to reduce login account-enumeration timing differences.
- Make the security-reporting instructions accurate before the repository's private vulnerability reporting feature is enabled and before the first tagged release exists.
- Separate operational administrators from the original primary administrator: only the primary administrator can export/restore all credentials, uninstall the service, create, promote, demote, modify, or delete administrator accounts.
- Block custom IMAP connections to loopback, private, link-local, metadata, documentation, multicast, and other reserved networks at validation and again after DNS resolution before every test or sync. Provider presets can no longer be redirected, remote plaintext IMAP is rejected, and imapsync must verify the source server's TLS certificate.
- Remove administrator password resets for other Web users. After account creation, sign-in passwords can only be changed by the user after verifying the current password, preventing application administrators from silently taking over a tenant session.
- Persist Maildir root ownership independently from sync-account records, so deleting an account while retaining its mail cannot expose that orphaned mailbox to the legacy administrator scope; restores now reject ownership conflicts and unknown generated tenant roots fail closed.
- Harden full installations by setting the managed mailbox home and Maildir directories to `0700` and message files to `0600`, and report unsafe filesystem permissions in `doctor.sh`.
- Add administrator-managed multi-user login with server-side role checks, account/job/log ownership filtering, per-user mailbox scopes, forced isolated destinations for new accounts, unforgeable Dovecot storage roots, session invalidation on user changes, personal password updates, and server-side page redirects. Existing accounts migrate to the first administrator without moving legacy mail.
- Restrict the legacy administrator compatibility scope to old unassigned folders and its own accounts; administrators can no longer read another user's isolated mailbox root.
- Clearly report HTTP as unencrypted instead of presenting application-layer password wrapping as a replacement for HTTPS.

- Restore message and folder totals with imapsync 2.290 by parsing its per-folder statistics when legacy Host1/Host2 summary counters are absent, including every retained historical successful job.

- Add confirmed bulk mark-as-read actions for a folder or displayed account group across all pages, with partial failure reporting and refreshed counts.

- Add verified local read/unread updates with CSRF protection, mark mail read only on explicit opening, and use inbox unread counts for account badges. Preserve existing destination flags during subsequent syncs with --noresyncflags.

- Redesign the read-only mailbox with account-aware folder groups (including legacy renamed and ungrouped destinations), collapsible folder trees, clearer unread/total counts, a wider message list, denser message cards, improved empty state, and automatic first-message preview on desktop.
- Keep the Node.js 20 compatibility CI lane green by skipping the Dovecot database integration fixture when the Node 22.5+ built-in SQLite test driver is unavailable, and update GitHub's official Actions to their Node 24-based v5 releases.
- Generate a unique random local Dovecot password for unattended and quick installations instead of using the shared `123456` default; legacy installations keep their existing warning and upgrade behavior.
- Improve HTML mail fidelity with embedded CID images, safe inline typography/table/spacing styles, a light message canvas, and privacy-gated remote images that load only on explicit user action.
- Add provider-aware quick links on the account form for QQ/NetEase authorization codes, Google app passwords and two-step verification, and Google/Microsoft OAuth application setup.
- Add a built-in read-only Web mailbox that reuses the authenticated session and local Dovecot credentials, with folder browsing, newest-first pagination, safe message-body rendering, blocked remote images/active content, and attachment metadata.
- Add a first-class Gmail app-password preset (`imap.gmail.com:993` over SSL), while retaining Gmail OAuth2 as the HTTPS callback-based option.
- Run `doveadm pw` without loading privileged system configuration and prevent asynchronous stdin `EPIPE` errors from crashing the Web service or helper path; failures now return bounded diagnostics without exposing passwords in process arguments.
- Add an MIT license and security reporting policy, and ignore temporary restore data, retained restore snapshots, backup archives, and checksum sidecars.
- Make the installer preserve directory privacy while ensuring the service can discover root-owned helpers under `/usr/local/sbin`.
- Roll back the Dovecot users file when helper reload fails, roll Dovecot back if committing `local-target.pass` fails, and remove stale per-account target-password overrides before changing the shared local user password.
- Prevent automatic localization from translating account names, usernames, and destination folder names; require complete English fallback coverage for all static Web text.
- Replace live SQLite directory copies in the CLI backup with the online backup API and manifest/hash format used by Web backups. CLI restore now requires the same bounded archive verification, preserves deployment identity, creates a pre-restore snapshot, and uses database+secret rollback.
- Regenerate the session identifier after administrator setup and login.
- Add runtime Web localization for Simplified Chinese, English, Japanese, Korean, Spanish, French, and German, with English fallback, translated dynamic status/time labels, settings and installer validation, and automated locale consistency checks.
- Add a Web restore center with streamed authenticated upload, archive/manifest/hash/SQLite preflight, bounded compressed and expanded sizes, session-bound confirmation, active-job blocking, pre-restore snapshots, live database import, atomic secret-directory switching, database+secret rollback, retained snapshot listing/download, and preservation of current administrator and deployment-specific Dovecot/Web settings.
- Add per-account advanced sync rules for exact folder inclusion/exclusion, recent-day and message-size limits, plus opt-in destination message mirroring. Existing accounts remain unrestricted and non-destructive; mirror deletion is restricted to isolated folders, rejects partial message windows, never enables source deletion, and requires a Web confirmation.

- Ensure each sync job is finalized only once when a child process emits both `error` and `close`.
- Close each job log stream before committing the final task state, preventing file descriptor leaks and incomplete log reads.
- Add a configurable 5-1440 minute timeout for sync jobs, with graceful termination followed by a forced kill after 10 seconds.
- Record timed-out jobs separately, include them in failure notifications, and allow them to be retried.
- Allow running sync jobs to be stopped from the log page, using only child processes owned by the current service process.
- Reuse the same graceful-then-forced termination path for timeouts, user cancellation, and service shutdown.
- Add dependency-free automated tests for imapsync output parsing, error classification, and graceful-to-forced process termination.
- Add SQLite integration tests for schema defaults, WAL/foreign-key setup, active-job uniqueness, cascading deletion, and startup repair of duplicate active jobs.
- Extract queue persistence and state transitions into a dependency-free job store, with integration tests for enqueue deduplication, FIFO selection, cancellation, retry, and bulk queued-job cancellation.
- Add reusable server-side validation for strict integer ranges, hostnames/IPs, system usernames, secrets, account enums, and boolean fields.
- Preserve an account's existing local Dovecot target user when editing through the current UI, which does not expose that field.
- Add CSP, anti-framing, MIME sniffing, referrer, permissions, opener, API no-cache, and HTTPS-only HSTS response headers.
- Add bounded reverse-proxy trust, automatic/forced Secure session cookies, and configurable bind host support.
- Reuse the graceful-to-forced process terminator for IMAP connection tests and ensure `error`/`close` can resolve each test only once.
- Add configurable 1-3650 day retention for completed sync jobs and logs, with cleanup at startup and every 24 hours.
- Make manual log cleanup remove the corresponding files as well as database rows, while preserving queued/running jobs and cleaning expired orphan logs safely.
- Bound log-detail reads to the newest 1 MiB, report truncation in the UI, and reject log paths that do not match the selected job inside the managed log directory.
- Add server-side pagination and account/status filters to the sync-job list, with bounded page sizes, stable ordering, totals, and supporting database indexes.
- Extract the scheduler loop and due-time calculation for deterministic testing, isolate per-account failures, and expose the latest scheduler error/result in health status.
- Prevent cancelled queued work from being recreated on the next 15-second tick, while keeping restart-interrupted work eligible for normal recovery; restart repair now clears stale PIDs.
- Show scheduler health, last tick, last error-free tick, and per-cycle counters on the Dashboard, including explicit stopped/error/stale warnings.
- Make shared frontend time formatting accept both SQLite UTC timestamps and ISO timestamps with timezone suffixes.
- Persist each log path when a sync starts so running-task output is immediately readable, and auto-refresh open running logs every 2 seconds (10 seconds in background tabs) without overlapping requests.
- Add password-confirmed Web backup export using SQLite's online snapshot API, a restore-script-compatible archive layout, strict secret-file permissions, single-export locking, and stale temporary-file cleanup.
- Exclude Maildir, cache, logs, temporary data, session signing keys, and root-owned runtime configuration from Web backups; require HTTPS for remote downloads and allow plain HTTP only from numeric loopback addresses.
- Add SHA-256 and byte size for every backed-up data file to the manifest, plus an archive-level SHA-256 response header and downloadable `sha256sum -c` sidecar file.
- Add a read-only streaming Web-backup verifier that checks the optional sidecar checksum, gzip/tar integrity, strict path/type allowlists, duplicate entries, manifest identity, and every payload size/hash without extracting files.
- Make service shutdown stop queue draining, wait for active imapsync children to finish the SIGTERM/SIGKILL path and commit their final state, and use a 15-second last-resort process exit.
- Add a backward-compatible per-account destination strategy: existing accounts remain flat, while new accounts can use imapsync's native `--subfolder2` mapping to isolate their complete folder tree under a validated, unique top-level folder.
- Add Gmail and Microsoft 365 OAuth2 authorization-code flows with PKCE/state validation, offline refresh tokens, protected client/token files, Web configuration, reauthorization status, and imapsync token-file/refresh-command integration that keeps all tokens out of process arguments.

## v0.1.6 — Sync Center Enhancements

- Added one-click sync for all enabled accounts.
- Added cancellation of all queued (not yet running) jobs.
- Added retry for failed, interrupted, and cancelled jobs while preserving the original job history.

## v0.1.5.4 — Separate Uninstall Confirmations

- Added separate confirmation fields for `REMOVE` and `PURGE`.
- The backend now strictly matches each confirmation to its selected uninstall mode.

## v0.1.5.3 — Uninstall Confirmation Fix

- Fixed the `REMOVE` Web uninstall flow: it now requires only the current Web administrator password and the browser confirmation dialog.
- Kept `PURGE` confirmation for the destructive Maildir deletion path.
- Separated the `REMOVE` and `PURGE` confirmation inputs in the Web UI.

## v0.1.5.2 — Installation Cleanup

- Added opt-in cleanup of the extracted source directory and uploaded archive after successful installation.
- Made Web uninstall confirmation accept the documented mode aliases.
- Added a clear error when the root uninstall helper has not been deployed.

## v0.1.5.1 — Safe Web Uninstall

- Added password-protected Web uninstall.
- Added `REMOVE` mode to remove Mail Aggregator while preserving Dovecot and Maildir.
- Added `PURGE` mode to remove Dovecot, the local mailbox user, and Maildir data.
- Added root-only uninstall helper with fixed sudoers commands.

## v0.1.5 — Operations Preview

- Added Dashboard health checks with actionable repair guidance.
- Added opt-in failed-sync notifications through HTTPS Webhooks and Telegram.
- Added per-account alert cooldown to prevent notification storms.
- Expanded secure backups to include runtime configuration alongside database and credentials.
- Added an explicit backup restore script that leaves Maildir untouched.
- Added password-protected Web uninstall with separate keep-data and purge modes.

## v0.1.4 — Public Beta

- Added quick, interactive custom, CLI and `--show-config` installation modes.
- Added one password-free runtime configuration model for Dovecot and Web settings.
- Added dynamic Dovecot user, host, IMAP port, Web port and language configuration.
- Added Alpine/OpenRC and Debian/Ubuntu/systemd installation layers.
- Added the Dovecot 2.3 adapter baseline and bounded password-change verification retries.
- Clarified the Web UI: default sync target and local Dovecot password are separate concepts.
- Added sensitive-data ignore rules.

## Compatibility

Alpine 3.21.7 with Dovecot 2.3.21.1 remains the fully tested golden environment. Debian and Ubuntu support is installer architecture support pending real-machine smoke tests.
