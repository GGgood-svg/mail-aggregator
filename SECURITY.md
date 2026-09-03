# Security Policy

## Supported version

Security fixes are applied to the latest release in this repository.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue containing mailbox credentials, OAuth tokens, backup archives, session cookies, server addresses, or exploit details that would put an active installation at risk.

Include the affected version, deployment platform, reproduction steps, impact, and any relevant sanitized logs. You should receive an acknowledgement through GitHub; please allow time for a fix before public disclosure.

## Sensitive artifacts

Mail Aggregator backup archives contain plaintext mailbox credentials and OAuth tokens. Store them encrypted and offline. Never attach a backup, the `data/` directory, `.pass`/`.secret` files, or `/etc/mail-aggregator/config` to an issue.
