# Mail Aggregator

English | [简体中文](./README.md)

[![CI](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml/badge.svg)](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A lightweight, self-hosted mail aggregator. It synchronizes multiple remote IMAP accounts into a local Dovecot mailbox with `imapsync`, then provides account management, scheduling, operations, and a read-only Web mailbox.

> Public Beta. New installations target Alpine Linux 3.24 x86_64 with Node.js 24 and Dovecot 2.4. Alpine 3.21 with Dovecot 2.3 is the historical baseline. See the [release checklist](./TESTING.md) for validation on other systems.

## Features

- QQ Mail, NetEase 163, Gmail, and custom IMAP accounts
- Administrator-managed users with isolated mail accounts, sync jobs, logs, and Web mailbox folders
- Gmail app passwords plus Gmail and Microsoft 365 OAuth2
- Manual, scheduled, and bulk sync with queueing, stop, cancel, retry, and logs
- Per-account destination folders and folder, age, and size filters
- Opt-in destination mirroring with strict deletion safety rules
- A built-in read-only mailbox backed by local Dovecot
- Unified unread overview, local stars and bulk read/unread and star changes
- [Durable mail tasks and rules](./MAIL_TASKS.md): complete previews, manual application, cancellation and authenticated resume
- Sanitized HTML mail, embedded CID images, and privacy-gated remote images
- Search one or all accessible folders by sender, recipient, subject, body, size, received date and read status
- Download attachments with Unicode filenames and export original `.eml` messages without changing read status
- Health checks, failure notifications, verified backups, restore preflight, and snapshots
- See why an account is blocked, when it will retry, pause scheduled sync, probe both IMAP endpoints without writing, and preview sync effects
- [Continue bounded searches](./MAIL_SEARCH_CONTINUATION.md), add private labels, filter attachments, and navigate mail on mobile; receipt-time sorting and conversation grouping cover the results currently displayed
- [Paired application and Maildir backups](./MAILDIR_BACKUP.md), [read-only operations and audit](./OPERATIONS.md), [primary administrator two-factor sign-in](./TOTP_SECURITY.md), and [GitHub update checks and signed installation](./APP_UPDATES.md)
- Simplified Chinese, English, Japanese, Korean, Spanish, French, and German UI

## Architecture

```text
Remote IMAP accounts
        │
        ▼
    imapsync queue ──► local Dovecot / Maildir
        │                         │
        └── status and logs       └── read-only Web mailbox
                    \             /
                     Mail Aggregator
```

Mail Aggregator manages synchronization; it does not replace Dovecot. Message data stays in Maildir. SQLite stores application configuration and job state. Mailbox credentials and OAuth tokens are stored separately in permission-restricted secret files.

## Quick install

### Download the release source

Select a version on [GitHub Releases](https://github.com/GGgood-svg/mail-aggregator/releases/latest) and download **Source code (tar.gz)**. The [complete deployment guide (Simplified Chinese)](./DEPLOYMENT.md) has copyable commands for downloading directly on the server or transferring the archive from another computer, plus upgrade, backup, and restore instructions. The signed Alpine update bundle does not include the first-time installation wizard.

### Web installation wizard (fresh Linux host)

The wizard accepts **Alpine 3.21 and later 3.x (OpenRC)**, **Debian 12/13 (systemd)** and **Ubuntu 22.04 / 24.04 / 26.04 and later Ubuntu releases recognized by the installer (systemd)** on `x86_64` and `aarch64`. The configured repositories must supply Dovecot 2.3 or 2.4. Prefer a distribution release still receiving maintenance.

- Alpine: if only `main` is enabled for this release, the wizard checks for `community` on the same mirror and release branch. When the index refresh succeeds, it backs up `/etc/apk/repositories` and adds that entry. An existing matching `community` or a custom configuration that cannot be safely matched is left as is. `--check` only reports the planned action.
- Debian / Ubuntu: a system npm and **Node.js 22.12 or later** at `/usr/bin/node` are required. If the configured apt sources cannot provide them, set up both from a trusted source first. A Node version installed only in a user's nvm profile cannot run the service. On Ubuntu, dependencies may require the distribution's `universe` repository.

After downloading and unpacking the release source, run the following from the extracted source directory as `root`:

```sh
sh scripts/install-web.sh
```

The installer detects the current private LAN IPv4 addresses on every launch. If there is one address, it uses it automatically. If there are several, choose by interface and address in the terminal. For unattended use with several addresses, run `sh scripts/install-web.sh --listen PRIVATE_LAN_IPV4` to select one explicitly. `sh scripts/install-web.sh --check` checks the system, existing installation, available addresses and Node.js without installing software.

1. Keep the terminal running. Open the printed `https://server-address:8090/` URL from the same LAN. The certificate is generated for this launch; compare its **SHA-256 fingerprint** in the browser with the terminal before continuing. You do not need to add it to the system trust store.
2. Enter the one-use setup code printed in the terminal within 15 minutes. After the checks pass, choose the panel port and language, specify your **web administrator username and password**, and start the installation. Refreshing or closing the browser does not stop the job. Return in the same browser to see progress.
3. After success, use **Show once** to save the separate Dovecot password for `mailuser`. Open the mail panel (by default `http://server-address:8080/`) and **sign in with the web administrator credentials you chose**. The Dovecot password is for local IMAP and the setup code is for pairing only.
4. Select **Finish and close wizard**. The temporary HTTPS listener also closes automatically five minutes after the installation ends.

The temporary wizard binds only the selected address and issues a certificate for that address. If the IP changes while the wizard is open, let any installation in progress finish. If you have not started installing, exit and restart the wizard and use the new URL, fingerprint and setup code in the terminal. After a default LAN installation, access the regular panel on its usual port (8080 by default) at the new IP. The regular panel uses HTTP; use an HTTPS reverse proxy for Internet access. The wizard refuses to take over an existing Mail Aggregator or Dovecot installation, related users, or mail data. Use the existing command-line workflows for upgrades and recovery. On failure, the wizard keeps any data written and the root-only progress log printed in the terminal, stops without retrying, and stops and disables the services it attempted to start. GitHub automatic updates have a separate platform matrix.

### Command-line installation

Enable the matching `main` and `community` repositories on a fresh Alpine 3.24 x86_64 machine, then run the installer from the extracted source directory as `root`:

```sh
sh scripts/install.sh --quick
```

Quick mode installs and initializes Dovecot, Maildir, imapsync, and Mail Aggregator. Use the interactive installer to select the local mailbox user, ports, language, and initial password:

```sh
./scripts/install.sh --custom
```

If no local Dovecot password is supplied, the installer generates a unique 32-character random password and prints it once when installation completes. Store it immediately.

Verify the installation:

```sh
./scripts/doctor.sh
rc-service dovecot status
rc-service mail-aggregator status
```

After a fresh command-line installation, the Web interface listens on `0.0.0.0:8080` by default. Open `http://server-lan-ip:8080` from the same trusted LAN to create the first administrator. This uses plain HTTP; use an HTTPS reverse proxy for Internet access.

### Application updates

The primary administrator can check GitHub releases under **Settings → Application updates**. Stable daily checks are on by default. Signed installation requires an eligible Alpine host, a pinned public key, and host opt-in. See [setup, upgrade, and rollback](./APP_UPDATES.md).

The primary administrator can enable two-step verification under **Personal security**. See the [recovery codes and console recovery guide](./TOTP_SECURITY.md) (Chinese).

## Users and isolation

The first account is the primary administrator. It can create standard users or operational administrators; public registration is disabled. Standard users can access only their own mail accounts, sync jobs, logs, and mailbox folders. Operational administrators can manage users and inspect system status, while global settings, OAuth client credentials, full backup/restore, service control, and uninstall remain restricted to the primary administrator.

The primary administrator and server `root` are trusted deployment boundaries. A full backup exported by the primary administrator contains every source-mail credential, and `root` can read the local Maildir directly. Web isolation protects standard users from each other and from operational administrators; it cannot protect data from someone who controls the host.

Users choose a display name for each mailbox, while the server assigns an unforgeable Dovecot storage root from the user and account IDs. Existing accounts are assigned to the first administrator without moving existing mail. Because legacy `flat` mode already merged messages into shared root folders, only the first administrator retains access to those legacy folders; other users can read only their server-assigned isolated roots.

If Dovecot is already configured, run `./scripts/install.sh --app-only`. This installs the application without rebuilding the existing Dovecot configuration. For backward compatibility, running the installer without arguments remains equivalent to `--quick` and performs a full installation.

## Account authentication

| Provider | Recommended method | Notes |
| --- | --- | --- |
| QQ Mail | Authorization code | Do not use the QQ sign-in password |
| NetEase 163 | Client authorization password | Enable IMAP in the mailbox settings |
| Gmail | App password | Simplest option; requires Google two-step verification |
| Gmail | OAuth2 | Requires an OAuth client and an HTTPS callback |
| Outlook / Microsoft 365 | OAuth2 | Requires a Microsoft Entra app registration and HTTPS callback |
| Other providers | Custom IMAP | Enter the provider host, port, TLS mode, and credential |

The account form includes provider-specific links to the relevant setup pages.

### OAuth2 and HTTPS

Google and Microsoft redirect the browser back to Mail Aggregator after consent. A public deployment therefore needs a stable HTTPS origin, for example:

```text
https://mail.example.com/api/oauth/callback/google
https://mail.example.com/api/oauth/callback/microsoft
```

App passwords and authorization codes use ordinary IMAP authentication and do not require an OAuth callback.

## Production proxy settings

Sign-in passwords are stored only as bcrypt hashes and mailbox credentials use protected files, but at-rest protection does not encrypt HTTP traffic. Over HTTP, both the password and session cookie can be intercepted, and a man in the middle can replace the page script. Mail Aggregator therefore does not present browser-side RSA/AES wrapping as a substitute for HTTPS.

Bind the application to loopback and terminate TLS at Caddy, Nginx, or another reverse proxy. The runtime configuration is `/etc/mail-aggregator/config`:

```sh
MAIL_AGG_BIND_HOST=127.0.0.1
MAIL_AGG_TRUST_PROXY=loopback
MAIL_AGG_COOKIE_SECURE=true
MAIL_AGG_REQUIRE_HTTPS=true
```

Upgrades keep the existing Web bind address and HTTPS settings. Use `--https-proxy` with a local HTTPS reverse proxy, `--local-http` to listen only on `127.0.0.1` (also reachable through an SSH tunnel), or `--lan-http` to explicitly enable plain HTTP on a trusted LAN.

Forward the original `Host`, `X-Forwarded-Proto`, and client address, then restart Mail Aggregator.

## Data and backups

The primary administrator can download a redacted diagnostic report from the dashboard. If the service cannot start, run `sudo /opt/mail-aggregator/scripts/doctor.sh --json` on the server and follow the [recovery guide](./TESTING.md#11-恢复中断与离线诊断).

| Content | Default path |
| --- | --- |
| Installed application | `/opt/mail-aggregator` |
| Application data | `/var/lib/mail-aggregator` |
| Runtime configuration | `/etc/mail-aggregator/config` |
| Local messages | `/home/<dovecot-user>/Maildir` |

Create, verify, and restore a backup:

```sh
sudo /opt/mail-aggregator/scripts/backup.sh
sudo /opt/mail-aggregator/scripts/verify-backup.sh backup.tar.gz backup.tar.gz.sha256
sudo /opt/mail-aggregator/scripts/restore.sh backup.tar.gz backup.tar.gz.sha256
```

Backups contain recoverable plaintext mailbox credentials. Encrypt and store them offline. Never upload a backup to an issue or public repository. Maildir is not included.

## Development

```sh
npm ci
npm test
```

Node.js 22.12 or later is required. Linux release checks and real-machine scenarios are documented in [TESTING.md](./TESTING.md).

## Security highlights

- Passwords and tokens use mode-`600` files and are not placed in URLs or imapsync arguments
- Authenticated state changes require CSRF validation
- Server-side ownership checks cover accounts, jobs, logs, and mailbox roots; administrative operations also require an administrator role
- Login throttling, persistent sessions, security headers, and configurable Secure cookies
- Escaped user content and allowlist-based HTML message sanitization
- Remote message images stay blocked until the user explicitly loads them
- Minimal-privilege Dovecot password helper with rollback on failure
- Path, type, size, manifest, hash, and SQLite integrity checks before restore

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md). Do not disclose credentials, tokens, cookies, private addresses, backups, or unsanitized logs in public issues.

## Current limitations

- The Web mailbox supports search, attachment downloads, original EML export and local read/unread and star changes; it cannot compose, reply, move or delete messages
- Cross-folder search checks up to eight folders per page and previews up to five messages per folder. Duplicate copies in different folders appear separately; body search depends on Dovecot and can be slow without full-text indexing. It does not promise to search attachment contents.
- The search end date includes that day. Body preview is limited to 10 MB; larger messages still expose attachment actions. Downloads are limited to 100 MB, two concurrent files per user and four globally
- The unread overview groups accessible folders and previews five messages per folder. Messages appearing in multiple folders are counted per folder.
- Read and star changes stay local. Subsequent syncs preserve local flags and do not update the source mailbox.
- Maildir is excluded from the application backup. A separate encrypted backup and isolated rehearsal are documented in [MAILDIR_BACKUP.md](./MAILDIR_BACKUP.md) (Chinese).
- Sources share one local Dovecot service account by default, but new accounts use unforgeable storage roots enforced by the Web API
- Google and Microsoft OAuth behavior still depends on provider console and tenant configuration
- Debian and Ubuntu installer support needs broader real-machine validation
- Back up and verify data before every upgrade or restore while the project remains in beta

## Contributing and license

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CHANGELOG.md](./CHANGELOG.md). Licensed under the [MIT License](./LICENSE).

The upcoming work and acceptance goals are outlined in [MAIL_ROADMAP.md](./MAIL_ROADMAP.md) (Chinese).
