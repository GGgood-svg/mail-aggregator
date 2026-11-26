'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

const REPO = 'GGgood-svg/mail-aggregator';
const PROTOCOL = 1;
const PLATFORM = 'alpine-3.24-x64-node24-openrc';
const ASSETS = { bundle: 'mail-aggregator-alpine-3.24-x64-node24.tar.gz', manifest: 'app-update.json', signature: 'app-update.sig' };
const MiB = 1024 * 1024;
const MAX_BUNDLE = 96 * MiB;
const TARGET = /^v(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?:-(beta|rc)(?:\.(0|[1-9]\d{0,7}))?)?$/;

class UpdateError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function ensure(condition, code) { if (!condition) throw new UpdateError(code); }
function version(value) {
  const match = typeof value === 'string' && TARGET.exec(value.startsWith('v') ? value : `v${value}`);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === 'beta' ? 0 : match[4] === 'rc' ? 1 : 2, match[5] === undefined ? -1 : Number(match[5])] : null;
}
function compare(a, b) {
  const x = version(a), y = version(b);
  ensure(x && y, 'invalid_version');
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function releaseCandidates(list, current, channel) {
  return list.filter(entry => {
    if (!entry || entry.draft !== false || typeof entry.prerelease !== 'boolean' || typeof entry.tag_name !== 'string' || !TARGET.test(entry.tag_name)) return false;
    const prerelease = version(entry.tag_name)[3] !== 2;
    return prerelease === entry.prerelease && (channel === 'preview' || !prerelease) && compare(entry.tag_name, current) > 0;
  }).sort((a, b) => compare(b.tag_name, a.tag_name));
}
function publicRelease(item) {
  return { tag: item.tag_name, url: `https://github.com/${REPO}/releases/tag/${item.tag_name}`, prerelease: item.prerelease,
    notes: typeof item.body === 'string' ? item.body.slice(0, 1400) : '' };
}
function decodeManifest(bytes, signature, publicKey, tag) {
  let manifest;
  try {
    const key = crypto.createPublicKey(publicKey);
    ensure(key.asymmetricKeyType === 'ed25519' && signature.length === 64 && crypto.verify(null, bytes, key, signature), 'invalid_signature');
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (e) { throw e instanceof UpdateError ? e : new UpdateError('invalid_manifest'); }
  ensure(manifest && manifest.protocol === PROTOCOL && manifest.repository === REPO && manifest.tag === tag && TARGET.test(tag)
    && /^[0-9a-f]{40}$/.test(manifest.commit) && manifest.bundle === ASSETS.bundle && manifest.platform === PLATFORM
    && Number.isSafeInteger(manifest.nodeAbi) && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_BUNDLE
    && /^[0-9a-f]{64}$/.test(manifest.sha256) && typeof manifest.automatic === 'boolean'
    && Array.isArray(manifest.from) && manifest.from.length <= 64 && (!manifest.automatic || manifest.from.length > 0)
    && new Set(manifest.from).size === manifest.from.length && manifest.from.every(v => typeof v === 'string' && TARGET.test(v) && compare(v, tag) < 0), 'invalid_manifest');
  return manifest;
}

const API = `https://api.github.com/repos/${REPO}/releases`;
const filesBase = `https://github.com/${REPO}/releases/download/`;
const allowedDownloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
async function request(url, { fetchImpl = fetch, api = false, signal = AbortSignal.timeout(20000) } = {}) {
  for (let n = 0; n < 4; n++) {
    const parsed = new URL(url);
    ensure(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
      (api ? parsed.hostname === 'api.github.com' : allowedDownloadHosts.has(parsed.hostname)), 'unexpected_download_host');
    let response;
    try { response = await fetchImpl(parsed, { redirect: 'manual', signal, headers: { 'User-Agent': 'Mail-Aggregator-Updater/1', ...(api && { Accept: 'application/vnd.github+json' }) } }); }
    catch (_) { throw new UpdateError(signal.aborted ? 'github_timeout' : 'github_unreachable'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      ensure(!api && location, 'unexpected_redirect');
      url = new URL(location, parsed).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UpdateError(response.status === 429 || response.status === 403 ? 'github_rate_limit' : response.status === 404 ? 'release_missing' : 'github_unavailable');
    }
    return response;
  }
  throw new UpdateError('unexpected_redirect');
}
async function small(response, limit, signal) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      ensure(size <= limit, 'response_too_large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) { throw e instanceof UpdateError ? e : new UpdateError(signal.aborted ? 'github_timeout' : 'github_unreachable'); }
  return Buffer.concat(chunks, size);
}
function deadline(options = {}, timeout = 20000) {
  return { ...options, signal: options.signal || AbortSignal.timeout(timeout) };
}
async function apiJson(url, limit, options) {
  const response = await request(url, { ...options, api: true });
  const bytes = await small(response, limit, options.signal);
  try { return { value: JSON.parse(bytes.toString('utf8')), headers: response.headers }; }
  catch (_) { throw new UpdateError('invalid_release_response'); }
}
async function discover(current, channel, options = {}) {
  options = deadline(options);
  const releases = [];
  for (let page = 1; page <= 5; page++) {
    const { value: items, headers } = await apiJson(`${API}?per_page=30&page=${page}`, MiB * 2, options);
    ensure(Array.isArray(items), 'invalid_release_response');
    releases.push(...items);
    if (items.length < 30 || !/rel="next"/.test(headers.get('link') || '')) break;
  }
  return releaseCandidates(releases, current, channel)[0] || null;
}
async function tagCommit(tag, options) {
  const repo = `https://api.github.com/repos/${REPO}/git`;
  const ref = (await apiJson(`${repo}/ref/tags/${tag}`, 16384, options)).value;
  ensure(ref?.ref === `refs/tags/${tag}`, 'release_changed');
  let object = ref.object;
  for (let i = 0; i < 4; i++) {
    ensure(/^[0-9a-f]{40}$/.test(object?.sha), 'release_changed');
    if (object.type === 'commit') return object.sha;
    ensure(object.type === 'tag', 'release_changed');
    object = (await apiJson(`${repo}/tags/${object.sha}`, 65536, options)).value?.object;
  }
  throw new UpdateError('release_changed');
}
async function readManifest(item, publicKey, options = {}) {
  ensure(TARGET.test(item.tag_name) && Array.isArray(item.assets)
    && Object.values(ASSETS).every(name => item.assets.some(asset => asset?.name === name && asset.state === 'uploaded')), 'manual_upgrade');
  options = deadline(options);
  const base = `${filesBase}${item.tag_name}/`;
  const [bytes, sig] = await Promise.all([
    request(base + ASSETS.manifest, options).then(res => small(res, 16384, options.signal)),
    request(base + ASSETS.signature, options).then(res => small(res, 64, options.signal)),
  ]);
  const manifest = decodeManifest(bytes, sig, publicKey, item.tag_name);
  ensure(manifest.commit === await tagCommit(item.tag_name, options), 'release_changed');
  return manifest;
}
async function download(manifest, filename, options = {}) {
  const signal = options.signal || AbortSignal.timeout(180000);
  const response = await request(`${filesBase}${manifest.tag}/${ASSETS.bundle}`, { ...options, signal });
  const hash = crypto.createHash('sha256');
  let count = 0;
  let output;
  try {
    output = await fs.open(filename, 'wx', 0o600);
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, cb) {
      count += chunk.length;
      if (count > manifest.bytes) return cb(new UpdateError('bad_package_size'));
      hash.update(chunk);
      cb(null, chunk);
    } }), output.createWriteStream(), { signal });
    ensure(count === manifest.bytes && hash.digest('hex') === manifest.sha256, 'bad_package_hash');
  } catch (error) {
    if (output) { await output.close().catch(() => {}); await fs.rm(filename, { force: true }); }
    else await response.body.cancel().catch(() => {});
    throw signal.aborted ? new UpdateError('github_timeout') : error?.name === 'TypeError' ? new UpdateError('github_unreachable') : error;
  }
}

module.exports = { REPO, PROTOCOL, PLATFORM, ASSETS, TARGET, MiB, MAX_BUNDLE, UpdateError, ensure, version, compare, releaseCandidates, publicRelease, decodeManifest, discover, readManifest, download };
