# Security Policy

## Supported version

Until the first tagged release, security fixes are applied to the latest commit on the default branch. After releases begin, only the newest release line will receive security fixes unless stated otherwise.

## Reporting a vulnerability

If the repository Security page offers **Report a vulnerability**, use that private form. If private reporting is unavailable, open a minimal public issue asking the maintainer to provide a private contact channel, but include no exploit details or sensitive environment information in that issue.

Do not put mailbox credentials, OAuth tokens, backup archives, session cookies, real server addresses, unsanitized logs, or working exploit details in a public issue.

Include the affected version, deployment platform, reproduction steps, impact, and any relevant sanitized logs. You should receive an acknowledgement through GitHub; please allow time for a fix before public disclosure.

## Web security profiles

Strict requires a protected connection for backup and restore or update installation. Trusted LAN lets directly connected clients on the same private IPv4 subnet use these operations over HTTP after password confirmation; an administrator with two-step verification must also confirm a fresh authenticator code. HTTP still exposes traffic to the local network. Do not port-forward the HTTP listener. Recovery codes and authenticator setup require HTTPS or SSH loopback access. No profile changes release signature verification or OAuth callback requirements.

## Sensitive artifacts

Mail Aggregator backup archives contain plaintext mailbox credentials and OAuth tokens. Store them encrypted and offline. Never attach a backup, the `data/` directory, `.pass`/`.secret` files, or `/etc/mail-aggregator/config` to an issue.
