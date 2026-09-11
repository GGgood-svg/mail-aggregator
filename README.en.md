# Mail Aggregator

English | [简体中文](./README.md)

[![CI](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml/badge.svg)](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A lightweight, self-hosted mail aggregator. It synchronizes multiple remote IMAP accounts into a local Dovecot mailbox with `imapsync`, then provides account management, scheduling, operations, and a read-only Web mailbox.

> Status: Public Beta. Alpine Linux 3.21.7, Node.js 22, Dovecot 2.3.21.1, and imapsync 2.290 are the fully verified baseline. Debian and Ubuntu adapters exist but have not received equivalent real-machine acceptance testing.

## Features

- QQ Mail, NetEase 163, Gmail, and custom IMAP accounts
- Administrator-managed users with isolated mail accounts, sync jobs, logs, and Web mailbox folders
- Gmail app passwords plus Gmail and Microsoft 365 OAuth2
- Manual, scheduled, and bulk sync with queueing, stop, cancel, retry, and logs
- Per-account destination folders and folder, age, and size filters
- Opt-in destination mirroring with strict deletion safety rules
- A built-in read-only mailbox backed by local Dovecot
- Sanitized HTML mail, embedded CID images, and privacy-gated remote images
- Health checks, failure notifications, verified backups, restore preflight, and snapshots
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

Run as `root` on a new Alpine machine:

```sh
cd /root/mail-aggregator
chmod +x scripts/*.sh scripts/lib/*.sh scripts/platforms/*.sh
./scripts/install.sh --quick
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

Fresh installations listen on loopback by default. Run `ssh -L 8080:127.0.0.1:8080 root@server-address`, then open `http://127.0.0.1:8080` to create the first administrator. Add `--lan-http` to the install command only for temporary testing on a trusted LAN. Put the application behind an HTTPS reverse proxy before exposing it to the Internet.

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

Use `./scripts/install.sh --full --https-proxy` when an HTTPS reverse proxy is already available. Use `--lan-http` only to opt into plain HTTP access from a trusted LAN; without either flag, new installs remain reachable only from the local machine or an SSH tunnel.

Forward the original `Host`, `X-Forwarded-Proto`, and client address, then restart Mail Aggregator.

## Data and backups

| Content | Default path |
| --- | --- |
| Installed application | `/opt/mail-aggregator` |
| Application data | `/var/lib/mail-aggregator` |
| Runtime configuration | `/etc/mail-aggregator/config` |
| Local messages | `/home/<dovecot-user>/Maildir` |

Create, verify, and restore a backup:

```sh
sudo ./scripts/backup.sh
./scripts/verify-backup.sh backup.tar.gz backup.tar.gz.sha256
sudo ./scripts/restore.sh backup.tar.gz backup.tar.gz.sha256
```

Backups contain recoverable plaintext mailbox credentials. Encrypt and store them offline. Never upload a backup to an issue or public repository. Maildir is not included.

## Development

```sh
npm ci
npm test
```

Node.js 22.5 or later runs the complete test suite. Older supported Node.js versions skip integration tests that depend on Node's built-in SQLite test driver. Linux release checks and real-machine scenarios are documented in [TESTING.md](./TESTING.md).

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

- The Web mailbox is read-only: no compose, reply, move, delete, or attachment download
- Sources share one local Dovecot service account by default, but new accounts use unforgeable storage roots enforced by the Web API
- Google and Microsoft OAuth behavior still depends on provider console and tenant configuration
- Debian and Ubuntu installer support needs broader real-machine validation
- Back up and verify data before every upgrade or restore while the project remains in beta

## Contributing and license

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CHANGELOG.md](./CHANGELOG.md). Licensed under the [MIT License](./LICENSE).
