# Bounded mail search and reading navigation

The mail page uses bounded searches. A directory group may be complete, still being scanned, or temporarily unavailable. Continue with the next group of folders, continue scanning only one folder, or retry that folder. If the server cannot calculate an exact count without lifting the scan limit, the page shows the count as unknown. A search applies to the mail available at the beginning of each folder's scan; refresh to include messages delivered later. Typing `all` into the sender, recipient, subject or body field searches for that text. The “all” options in the read and starred filters still mean no filter.

On mobile, opening a message switches to a reading view. Use **Back to list** or the browser Back command to restore the list and focus. Previous and next message also cross page boundaries in the active list. When focus is in the reader, the left/right arrows and Escape provide the same navigation. Opening a message may mark it read; displaying a preview or restoring the list does not.

## Search API

Existing endpoints continue to accept their original query and paging fields. Request `continuation: true` in the JSON body to use signed cursors on `POST /api/mail/search` or `POST /api/mail/messages/search`.

- Use the same filter fields for all requests in a search. A single-folder search returns `state`, `reason`, `resumeCursor`, a `pageCursor` for revisiting the same range, `uidValidity`, the bounded messages and `total` (nullable). Follow `resumeCursor` as `cursor` in a request for the same folder; send `page` for display only. `beforeUid` and `knownTotal` are legacy fields and cannot be combined with signed cursors.
- A cross-folder search still returns `groups`, each with `state: complete | limited | failed`. Follow `nextFoldersCursor` to the next group, or follow a group's `resumeCursor` or `retryCursor` for that folder alone. A group result with no messages and `reason: scan_limit` is not a no-results result. Next-folder position survives even if the current batch all reached the scan budget. Scoped requests return just the affected group.
- Cursors bind normalized criteria, user, session, mail access and scan position. Per-folder positions include UIDVALIDITY and the initial UID ceiling. They expire after 15 minutes and are also invalidated by a service restart. An invalid cursor returns `409` / `SEARCH_CURSOR_INVALID`; a folder the requester cannot access still returns the same generic `404` as elsewhere. Restarts of the search start without a cursor.

## Rule previews and older versions

Rule previews freeze a UID ceiling and UIDVALIDITY for each folder before collecting any matching UIDs. The scanner writes at most 200 matching UIDs per block. An incomplete preview cannot be applied. When a folder temporarily fails after the scope is frozen, **Continue task** uses the last saved scan checkpoint and will not search successfully completed folders again. It still checks each frozen folder's permission and rechecks its UIDVALIDITY before completing. Preview collection is limited to one hour and 50,000 matches; the existing ten-minute application window starts after completion.

An older application version can still apply its own completed legacy previews and process in-flight rule applications. Previews in the new format use a database state that older versions cannot apply; return to the new version or create a fresh preview. New applications copy a compatibility list once at submission; the current app reads their frozen blocks rather than repeatedly parsing the entire list.


The search UI can filter by non-inline attachment presence, sanitized display filename, or exact/type-wildcard MIME media type. Saved searches retain these filters; rule editors explicitly exclude them. A single continuation step examines up to 20 candidates in one folder (five per folder in cross-folder previews). It advances by inspected candidate UIDs and can continue even when no messages match. The attachment view fetches body structure and envelope metadata, lists up to ten matching files per message, and delegates opening and streaming downloads to the normal reader and download endpoints.

Cross-folder searches can sort the currently displayed matches by IMAP `INTERNALDATE` descending, with folder ascending and UID descending as tie breakers. Results from other pages, unfinished scans, and unavailable folders are excluded, and the UI keeps per-folder navigation and retry controls.

Optional conversation grouping is limited to the currently displayed results. It asks for the `References` header only when enabled and combines it with `Message-ID` and `In-Reply-To` from the envelope. A bounded, subject-free membership calculation is scoped to the authorized account; a legacy folder with no confirmed root is isolated. All original messages remain visible and no headers, conversation keys, or group memberships are persisted.

Rule previews sample up to three envelope subjects and receipt timestamps per folder. Sample retrieval is read-only and separately reports failures. Per-folder access is checked when reading task details, including after permissions change; a partial scan still cannot be applied.
