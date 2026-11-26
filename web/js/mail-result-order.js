(function () {
  const timestamp = message => { const time = Date.parse(message.receivedAt); return Number.isFinite(time) ? time : -Infinity; };
  const compareFolder = (a, b) => a === b ? 0 : a < b ? -1 : 1;
  function compareReceived(a, b) {
    const aTime = timestamp(a.message), bTime = timestamp(b.message);
    return (aTime === bTime ? 0 : aTime > bTime ? -1 : 1)
      || compareFolder(a.group.folder, b.group.folder) || b.message.uid - a.message.uid;
  }
  function scannedByReceived(groups) {
    return groups.flatMap(group => group.ok ? group.messages.map(message => ({ group, message })) : []).sort(compareReceived);
  }

  // In-memory only. Preserve at most the most recent rows from explicit scans,
  // plus bounded per-folder positions so earlier directories can be resumed.
  function createReceivedScan({ maxRows = 300, maxFolders = 128, maxWeight = 2 * 1024 * 1024 } = {}) {
    const groups = new Map();
    let scope, lastPage = 0, moreFolders = true, limited = false;
    const reset = () => { groups.clear(); scope = undefined; lastPage = 0; moreFolders = true; limited = false; };
    function checkScope(tag) {
      if (!tag || (scope && scope !== tag)) reset();
      scope = tag;
      return !!tag;
    }
    function merge(raw, continued = false) {
      const { folder, uidValidity, messages, scanBefore, scanAfter, scanCeiling, ...rest } = raw;
      let group = groups.get(folder);
      if (!group && groups.size >= maxFolders) { limited = true; return; }
      if (!group || raw.reason === 'mailbox_changed' || (group.uidValidity && uidValidity &&
          (group.uidValidity !== uidValidity || group.scanCeiling !== scanCeiling))) {
        group = { folder, rows: new Map() };
        groups.set(folder, group);
      }
      if (!raw.ok) {
        // Keep a valid continuation if only a repeat of the first slice failed.
        if (continued || group.scanAfter === undefined) group.control = { ...rest, folder, messages: [] };
        return;
      }
      group.uidValidity = uidValidity;
      group.scanCeiling = scanCeiling;
      // The displayed slice may have been reloaded. Treat deletions, flag/filter
      // changes and replacements in the interval just scanned as authoritative.
      const lo = scanAfter || 1;
      for (const uid of group.rows.keys()) if (uid >= lo && uid < scanBefore) group.rows.delete(uid);
      for (const message of messages) group.rows.set(message.uid, { message, weight: JSON.stringify(message).length * 2 });
      if (continued || group.scanAfter === undefined || scanAfter <= group.scanAfter) {
        group.scanAfter = scanAfter;
        group.control = { ...rest, folder, uidValidity, messages: [] };
      }
    }
    function ordered() {
      return [...groups.values()].flatMap(group => [...group.rows.values()].map(row => ({ group, ...row }))).sort(compareReceived);
    }
    function trim() {
      // Usually the set is small. Avoid re-sorting unless one budget is exceeded.
      let count = 0, weight = 0;
      for (const group of groups.values()) for (const row of group.rows.values()) { count++; weight += row.weight; }
      if (count <= maxRows && weight <= maxWeight) return;
      limited = true;
      for (const item of ordered().reverse()) {
        if (count <= maxRows && weight <= maxWeight) break;
        item.group.rows.delete(item.message.uid); count--; weight -= item.weight;
      }
    }
    return {
      reset,
      page(data, page) {
        if (!checkScope(data.scopeTag)) return;
        for (const group of [...data.groups, ...(data.emptyGroups || [])]) merge(group);
        if (page >= lastPage) { lastPage = page; moreFolders = !!data.nextFoldersCursor; }
        trim();
      },
      slice(data) { if (checkScope(data.scopeTag)) { for (const group of data.groups) merge(group, true); trim(); } },
      rows: () => ordered().map(({ group, message }) => ({ group, message })),
      controls: () => [...groups.values()].map(group => group.control).sort((a, b) => compareFolder(a.folder, b.folder)),
      coverage: () => ({ limited, moreFolders, incomplete: [...groups.values()].some(group => group.control.state !== 'complete'),
        complete: !!lastPage && !moreFolders && !limited && [...groups.values()].every(group => group.control.state === 'complete') }),
    };
  }

  function groupConversations(results) {
    const parents = results.map((_, i) => i), previous = new Map();
    const leader = i => {
      while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; }
      return i;
    };
    results.forEach(({ message }, i) => {
      for (const token of message.threadTokens || []) {
        if (!previous.has(token)) { previous.set(token, i); continue; }
        const a = leader(i), b = leader(previous.get(token));
        parents[Math.max(a, b)] = Math.min(a, b);
      }
    });
    const grouped = new Map();
    results.forEach((result, i) => {
      const root = leader(i);
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root).push(result);
    });
    return [...grouped.values()];
  }
  if (typeof module === 'object') module.exports = { scannedByReceived, groupConversations, createReceivedScan };
  else window.MailResultOrder = { scannedByReceived, groupConversations, createReceivedScan };
})();
