# Mail search, attachments and original export

## Use

Open **查看邮件**. The search form applies to the currently selected folder.
Sender and subject are substring searches delegated to IMAP; received-date and
read-status conditions are combined with them. The end date includes that day.
Search criteria remain active when switching folders, while pagination resets.
Use **清除筛选** to return to the full folder listing.

Each selected message has **导出原始邮件**. Attachments with downloadable MIME
parts have **下载附件**. Filenames support Unicode; unsafe path characters,
control characters, bidirectional overrides and Windows device names are
sanitized. EML export streams the original message rather than reconstructing it
from the HTML preview. Both download operations open the mailbox read-only and
do not change message flags.

Body preview remains limited to 10 MiB. Larger messages return metadata and
attachment actions without loading the whole source into the Web process.
Attachment size labels come from the IMAP body structure and can include
transfer-encoding overhead. Each download is limited to 100 MiB, with at most
two concurrent downloads per user and four per process. A two-minute streaming
timeout, byte guard and disconnect cleanup bound resource use. The UI waits for
a successful response before offering the file for saving; failures are shown
in the mailbox instead of navigating away.

## API additions

- `GET /api/mail/messages`: optional `from`, `subject` (up to 200 characters),
  `since`, `until` (`YYYY-MM-DD`, received dates), `seen` (`all`, `read`, `unread`).
  `total` counts matching messages; `mailboxTotal` counts the whole folder.
  Existing UID cursor pagination applies after filtering.
- `GET /api/mail/messages/:uid/export?folder=...&uidValidity=...`
- `GET /api/mail/messages/:uid/attachments/:part/download?folder=...&uidValidity=...`

Downloads require the current UIDVALIDITY, recheck folder ownership, verify that
the message exists and only accept part IDs enumerated from its attachment
structure. They do not accept filesystem paths. Responses use attachment
disposition, octet-stream content type, no-store and nosniff headers. The same
authentication middleware as the existing mail APIs protects both routes.

## Validation

Run `npm test` and `npm run test:integration`. The feature tests cover combined
filters, dates, Unicode filenames, byte-preserving EML, attachment enumeration,
foreign folders, stale UIDVALIDITY, missing messages, body-part guessing, large
message metadata, stream limits, per-user/global concurrency and disconnects.
The native smoke test additionally checks authentication on the new routes.

Browser checks used synthetic mail and the actual page/router to verify desktop
and mobile layouts, search/reset, both downloads and error presentation. A live
Dovecot mailbox with real MIME variants still needs deployment acceptance.
