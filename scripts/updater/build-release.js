'use strict';
// Run in the pinned release environment after the build has passed its checks.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { ASSETS, PROTOCOL, REPO, PLATFORM, TARGET, compare, ensure, MAX_BUNDLE } = require('./release');
const { extract } = require('./archive');
const { createReadStream } = require('node:fs');

async function digest(filename) {
  const sum = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) sum.update(chunk);
  return sum.digest('hex');
}
async function main() {
  const [op, dir, stage, tag, commit, versions = '', policy = 'manual'] = process.argv.slice(2);
  const bundle = path.join(dir, ASSETS.bundle);
  if (op === 'validate') return extract(bundle, stage);
  if (op === 'sign') {
    const key = crypto.createPrivateKey(Buffer.from(process.env.RELEASE_SIGNING_KEY_B64 || '', 'base64').toString('utf8'));
    ensure(key.asymmetricKeyType === 'ed25519', 'invalid_signing_key');
    const manifest = await fs.readFile(path.join(dir, ASSETS.manifest));
    const meta = JSON.parse(manifest);
    ensure(meta.bytes === (await fs.stat(bundle)).size && meta.sha256 === await digest(bundle), 'build_artifact_mismatch');
    return fs.writeFile(path.join(dir, ASSETS.signature), crypto.sign(null, manifest, key), { flag: 'wx' });
  }
  const from = versions.split(',').map(v => v.trim()).filter(Boolean);
  const metadata = JSON.parse(await fs.readFile(path.join(stage, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(stage, 'package-lock.json'), 'utf8'));
  const bytes = (await fs.stat(bundle)).size;
  ensure(op === 'manifest' && TARGET.test(tag) && `v${metadata.version}` === tag && lock.version === metadata.version
    && metadata.name === 'mail-aggregator' && /^[0-9a-f]{40}$/.test(commit) && ['manual', 'automatic'].includes(policy)
    && bytes > 0 && bytes <= MAX_BUNDLE && from.length <= 64 && new Set(from).size === from.length
    && from.every(v => TARGET.test(v) && compare(v, tag) < 0) && (policy === 'manual' || from.length > 0), 'invalid_build_metadata');
  ensure(process.platform === 'linux' && process.arch === 'x64' && process.versions.node.startsWith('24.'), 'wrong_build_platform');
  await fs.writeFile(path.join(dir, ASSETS.manifest), `${JSON.stringify({ protocol: PROTOCOL, repository: REPO, tag, commit, bundle: ASSETS.bundle,
    platform: PLATFORM, nodeAbi: Number(process.versions.modules), bytes, sha256: await digest(bundle), automatic: policy === 'automatic', from })}\n`, { flag: 'wx' });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
