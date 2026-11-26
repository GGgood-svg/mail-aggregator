'use strict';

const { destinationRoot } = require('./folder-strategy');
const { folderRuleLists } = require('./sync-policy');

function namespaceOf(rows, namespace) {
  return {
    prefix: typeof namespace?.prefix === 'string' ? namespace.prefix : '',
    delimiter: namespace?.delimiter || rows.find(row => row.delimiter)?.delimiter || '/',
  };
}

function targetScope(account, folders, namespace) {
  const root = destinationRoot(account);
  if (!root) return { folders, root: null };
  const { prefix, delimiter } = namespaceOf(folders, namespace);
  const fullRoot = `${prefix}${root}`;
  return { root: fullRoot, folders: folders.filter(row => row.path === fullRoot || row.path.startsWith(`${fullRoot}${delimiter}`)) };
}

function selectable(folder) {
  return ![...(folder.flags || [])].some(flag => ['\\noselect', '\\nonexistent'].includes(String(flag).toLowerCase()));
}

function mapFolder(path, source, target, root) {
  // imapsync 2.314 defaults: replace namespace and swap delimiters; in a
  // slash-to-dot migration a literal slash remaining in a component becomes '_'.
  const from = source.delimiter, to = target.delimiter;
  let name = path === source.prefix ? 'INBOX' : path.startsWith(source.prefix) ? path.slice(source.prefix.length) : path;
  if (from !== to) name = [...name].map(char => char === to ? from : char === from ? to : char).join('');
  if (from === '/' && to !== '/') name = name.replaceAll('/', '_');
  if (root) return `${target.prefix}${root}${to}${/^inbox$/i.test(name) ? 'INBOX' : name}`;
  return /^inbox$/i.test(name) ? 'INBOX' : `${target.prefix}${name}`;
}

function syncImpact(account, source, target) {
  const from = namespaceOf(source.folders, source.namespace), to = namespaceOf(target.folders, target.namespace);
  const root = destinationRoot(account);
  const rules = folderRuleLists(account);
  const include = new Set(rules.include), exclude = new Set(rules.exclude);
  const mirrorMessages = account.deletion_mode === 'mirror_messages';
  // The pinned imapsync release sanitizes --subfolder2. Refuse to predict a
  // flat or changed destination when a legacy root does not survive that step.
  if ((root && !/^[A-Za-z0-9 _-]+$/.test(root)) || (account.destination_mode === 'subfolder' && !root)) {
    return { status: 'review_required', reason: 'legacy_destination', mirrorMessages, rows: [] };
  }
  const allowedTarget = targetScope(account, target.folders, target.namespace);
  const existing = new Map(allowedTarget.folders.map(row => [row.path, row]));
  const all = [];
  const mapped = new Map();
  for (const folder of source.folders) {
    // imapsync's include/exclude operates on raw LIST names. Keep it consistent
    // with the actual arguments for older servers that use modified UTF-7.
    const wirePath = folder.pathAsListed || folder.path;
    const item = { source: folder.path, destination: null, action: 'skip', subscribe: 'not_applicable', mayDeleteMessages: false };
    all.push(item);
    if (!selectable(folder) || (include.size && !include.has(wirePath)) || exclude.has(wirePath)
        || (root && wirePath.includes(root))) continue;
    item.destination = mapFolder(folder.path, from, to, root);
    const found = existing.get(item.destination);
    item.action = found ? (selectable(found) ? 'use' : 'conflict') : 'create';
    item.subscribe = folder.path.toUpperCase() === 'INBOX' || typeof folder.subscribed !== 'boolean'
      ? 'unknown' : folder.subscribed && !found?.subscribed ? 'possible' : 'not_needed';
    item.mayDeleteMessages = mirrorMessages && item.action === 'use';
    const key = item.destination.normalize('NFC').toLowerCase();
    const previous = mapped.get(key);
    if (previous) {
      for (const conflict of [previous, item]) {
        conflict.action = 'conflict'; conflict.subscribe = 'not_applicable'; conflict.mayDeleteMessages = false;
      }
    } else mapped.set(key, item);
  }
  const counts = { use: 0, create: 0, skip: 0, conflict: 0 };
  for (const item of all) counts[item.action]++;
  return { status: 'estimate', rows: all, counts,
    rootMayBeCreated: Boolean(allowedTarget.root && !existing.has(allowedTarget.root) && counts.create),
    mirrorMessages, maxAgeDays: account.max_age_days ?? null, maxSizeMb: account.max_size_mb ?? null };
}

module.exports = { syncImpact, targetScope };
