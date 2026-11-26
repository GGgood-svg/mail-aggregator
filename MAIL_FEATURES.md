# Mail search, attachments and original export

See [bounded search and reading navigation](./MAIL_SEARCH_CONTINUATION.md) for signed cursors, mailbox retry, and the new reader controls.

## Use

Open **查看邮件**. Choose the current folder or all accessible folders as the
search scope. Sender, recipient, subject and body are substring searches
delegated to IMAP; received-date, read-status, star-status and size conditions are combined
with them. Size limits are strict (greater than / smaller than), use 1 MB =
1,048,576 bytes and accept integers from 1 to 4095. The end date includes that
day. Clicking a physical folder exits a smart view and clears its filters.
The cross-folder result link retains the executed search conditions, including
when the form has been edited without submitting it. The unified unread link
retains only unread status. These transitions reset pagination and the reader.

Failed page loads keep the last successful page position and offer a retry.
Read-state responses are scoped to folder, UID and UIDVALIDITY; a delayed reply
from a rebuilt mailbox cannot update a different message in the reader.

Cross-folder results are grouped by folder, not globally sorted by date. Each
page checks up to eight accessible folders and previews up to five results per
folder. Use the folder link to view all of its results. An empty page may still
have later folders; follow **下一页**. A failed folder is shown separately and
the page can be retried. Folder changes during pagination may require a fresh
search, and copies in multiple folders appear separately.

Body search uses the local Dovecot IMAP search implementation. It does not
promise to search attachment contents; performance and Chinese matching depend
on Dovecot's configuration and any full-text index. This feature does not install
or configure such an index. Dovecot documents that body searches without a
high-performance index may require scanning message data: [Dovecot FTS 2.3](https://doc.dovecot.org/2.3/configuration_manual/fts/).

The Web UI sends search criteria in POST request bodies rather than URLs, with
the normal authenticated CSRF protection. The legacy GET list API remains
available for clients that need it; clients using that API should account for
possible URL logging by their reverse proxy. POST bodies can also be logged if a
server or proxy is explicitly configured to record them.

**统一未读** shows unread mail in the current user's accessible folders, grouped
by source folder. Each group previews up to five messages and links to the full
unread list for that folder. Ten folder groups are shown per page. The total is
the sum of per-folder unread counts, so a message appearing in multiple folders
can be counted more than once. Selecting a message opens and marks it read;
automatic preview does not mark it read.

Use the star beside a message, or select messages on the current page and apply
read/unread or star/unstar. Changes affect the local Dovecot copy only. The
server checks folder ownership and UIDVALIDITY separately for every folder;
partial or uncertain outcomes are reported, followed by a refresh.

**星标邮件** opens a cross-folder view of local `\Flagged` messages. The search
form can combine starred or unstarred status with all other filters.

Use **保存搜索** to create a user-owned smart folder, up to 50 per user. These
shortcuts save the folder scope and normalized filters; they do not copy mail,
store selected message IDs, or retain pagination. The pencil edits the name and
scope, including selecting a different accessible folder. To change conditions,
open the shortcut, adjust the search form, and use **更新当前搜索**. Deleting a
shortcut keeps every message. A missing or inaccessible target stays unavailable
and never falls back to another folder. The editor can repair its target.

Saved searches are part of application database backups. Restore maps their
owners by username, replaces only mapped users' searches, allocates fresh IDs,
validates filters and caps each imported user's searches at 50. Unmatched owners
and invalid/excess rows are skipped and counted. Current users absent from the
backup retain their searches; a legacy backup without the table preserves all
current searches. Folder availability is rechecked against current permissions
and the IMAP folder list when the view is opened.

Each selected message has **导出原始邮件**. Attachments with downloadable MIME
parts have **下载附件**. Filenames support Unicode; unsafe path characters,
control characters, bidirectional overrides and Windows device names are
sanitized. EML export streams the original message rather than reconstructing it
from the HTML preview. Both download operations open the mailbox read-only and
do not change message flags.

Raw MIME preview input remains limited to 10 MiB. Larger messages return metadata and
attachment actions without loading the whole source into the Web process.
Attachment size labels come from the IMAP body structure and can include
transfer-encoding overhead. Each download is limited to 100 MiB, with at most
two concurrent downloads per user and four per process. A two-minute streaming
timeout, byte guard and disconnect cleanup bound resource use. The UI waits for
a successful response before offering the file for saving; failures are shown
in the mailbox instead of navigating away.

MIME parsing and HTML sanitization run in one bounded worker, with four waiting
jobs and a 15-second deadline from submission. Queue saturation, parser failure
or deadline returns a generic 503. Cancelling a preview terminates its worker;
the slot is retained until the worker exits. The display result omits raw MIME
and downloadable attachment payloads; safe inline images can still appear as
data URLs within the sanitized HTML. Mailparser keeps CID links until our
sanitizer expands them with a total 2 MiB inline-image budget. The worker checks
a 4 MiB display/payload budget before posting to the Web thread and has a
128 MiB old-generation heap limit. Oversized results omit the whole body with
an explicit reason, preserving summary and attachment/export actions instead
of truncating HTML. Heap limits do not bound total process RSS. Download/export remains streamed.

**整理规则** creates a rule from the current search, previews all chosen folders,
then applies one read/unread or star/unstar action manually. **邮件整理** in the
logs page shows durable task history, cancellation, verified progress and manual
resume after a fresh login. See [mail tasks and rules](./MAIL_TASKS.md) for the
scope, safety limits, API contract and backup behavior.

## API additions

- `POST /api/mail/messages/search` (JSON) and the compatible `GET /api/mail/messages`:
  optional `from`, `to`, `subject`, `body` (up to 200 characters), `largerMb`,
  `smallerMb` (decimal strings from `1` to `4095`), `since`, `until`
  (`YYYY-MM-DD`, received dates), `seen` (`all`, `read`, `unread`), and `flagged`
  (`all`, `starred`, `unstarred`).
  `total` counts matching messages on the first page; subsequent pages may
  retain that snapshot as the mailbox changes. `mailboxTotal` counts the whole
  folder. UID cursor pagination applies after filtering. Ordinary lists search
  backward in UID windows; filtered counts use ESEARCH when available and fall
  back to a full UID search when the server lacks it.
- `POST /api/mail/search`: the same filters in a JSON body, plus optional `after`
  folder cursor. Requires at least one filter. Returns matching previews or
  individual errors for up to eight accessible folders, `scannedFolders`,
  `totalFolders`, and `nextAfter`. At most two IMAP clients are used concurrently
  and each folder has a 12-second deadline. No exact global message total is
  claimed; authorization is checked before and during the request.
- `GET /api/mail/unread?after=...`: up to ten accessible unread folder groups,
  each with at most five previews, unread count, UIDVALIDITY and a partial-error
  indicator. `nextAfter` advances by folder name.
- `PUT /api/mail/messages/flags`: accepts up to 100 `{folder,uidValidity,uid}`
  references plus `flag` (`seen` or `flagged`) and boolean `value`. Returns
  per-folder confirmed updates, missing messages and failures. A null updated
  count means the write outcome could not be confirmed.
- `POST /api/mail/seen-jobs` and `GET /api/mail/seen-jobs/:id`: create and query
  an owner-scoped background mark-read job. Confirmed counts and per-folder
  failures are visible while it runs. This is a compatibility layer over the
  durable task service. Each user's ended history is retained for up to 7 days
  and 100 records. Restart interrupts jobs; manual resume revalidates the saved
  UID boundary and confirms outstanding flags before issuing further writes.
- `GET /api/mail/seen-jobs/active` finds the current user's active job when its
  browser tab no longer has the job ID.
- `GET /api/mail/saved-searches`: returns the current user's `searches` and
  `maximum`. `available` expresses folder authorization; the UI additionally
  checks actual folder existence against `/folders`.
- `POST /api/mail/saved-searches` and `PUT /api/mail/saved-searches/:id`: JSON
  `{name,scope,folder,filters}`. `scope` is `folder` or `all`; a folder scope
  requires an explicit path, while an all scope requires at least one filter.
  Names are 1–80 characters. Unknown filter keys, UIDs, page state and caller-
  selected owners are rejected. All mutations use the short state lock.
- `DELETE /api/mail/saved-searches/:id`: removes only the caller's shortcut.
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
