"use strict";

const fs = require('node:fs');
const path = require('node:path');

const MAX_MOUNTINFO = 1024 * 1024;
const decodePath = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

function parseMountInfo(text) {
  const mounts = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf(' - ');
    if (separator < 0) throw new Error('Invalid Linux mount info');
    const [id, , device, root, point, options] = line.slice(0, separator).split(' ');
    const [type, source, superOptions] = line.slice(separator + 3).split(' ');
    if (!/^[1-9]\d*$/.test(id) || !/^\d+:\d+$/.test(device) || !root || !point || !options || !type || !source || !superOptions || mounts.has(id)) {
      throw new Error('Invalid Linux mount info');
    }
    mounts.set(id, { point: decodePath(point),
      // Use the mounted filesystem and its root, not the transient Linux mount ID. A
      // remount of the same volume may receive another ID and should recover normally.
      signature: JSON.stringify([device, root, point, type, source]),
      readOnly: options.split(',').includes('ro') || superOptions.split(',').includes('ro') });
  }
  if (!mounts.size) throw new Error('Empty Linux mount info');
  return mounts;
}

async function readLinuxMountInfo() {
  const fd = await fs.promises.open('/proc/self/mountinfo', 'r');
  try {
    const bytes = Buffer.allocUnsafe(MAX_MOUNTINFO + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await fd.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_MOUNTINFO) throw new Error('Linux mount info exceeds the probe budget');
    return parseMountInfo(bytes.toString('utf8', 0, size));
  } finally { await fd.close(); }
}

async function readLinuxDirectory(directory) {
  const fd = await fs.promises.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const [stats, identity, fdinfo] = await Promise.allSettled([
      fs.promises.statfs(`/proc/self/fd/${fd.fd}`), fd.stat({ bigint: true }),
      fs.promises.readFile(`/proc/self/fdinfo/${fd.fd}`, 'utf8'),
    ]);
    if (stats.status !== 'fulfilled') throw stats.reason;
    return { stats: stats.value, device: identity.status === 'fulfilled' ? identity.value.dev : null,
      mount: fdinfo.status === 'fulfilled' ? /^mnt_id:\s*([1-9]\d*)$/m.exec(fdinfo.value)?.[1] : null };
  } finally { await fd.close(); }
}

function configuredMounts(value) {
  if (!value) return null;
  const entries = JSON.parse(value);
  const validUses = new Set(['application', 'database', 'credentials', 'logs', 'cache', 'temporary', 'restore_points', 'mail']);
  if (entries === null || Array.isArray(entries) || typeof entries !== 'object') throw new Error('Invalid required mount settings');
  const result = new Map();
  for (const [use, point] of Object.entries(entries)) {
    // A required mount point is the kernel mount path in the process namespace.
    // Requiring '/' would permit the very root-volume fallback this setting prevents.
    if (!validUses.has(use) || typeof point !== 'string' || !point.startsWith('/') || point === '/' ||
      path.posix.normalize(point).replace(/\/$/, '') !== point || /[\0\r\n]/.test(point)) throw new Error('Invalid required mount setting');
    result.set(use, point);
  }
  return result;
}

module.exports = { configuredMounts, parseMountInfo, readLinuxMountInfo, readLinuxDirectory };
