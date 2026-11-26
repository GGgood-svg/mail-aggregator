'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { REPO, PLATFORM, PROTOCOL, ASSETS, TARGET, MAX_BUNDLE, compare } = require('./release');
const REQUIRED_CI = ['test (22.12)', 'test (24)', 'dependency-audit', 'dovecot-integration', 'browser-regression'];
const REQUIRED_REHEARSALS = ['cutover', 'rollback', 'restartRecovery'];
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function requireGate(ok, reason) { if (!ok) throw new Error(reason); }
function validateBuildManifest(manifest, tag) {
  requireGate(manifest?.repository === REPO && manifest.protocol === PROTOCOL && manifest.tag === tag && TARGET.test(tag) &&
    /^[a-f0-9]{40}$/.test(manifest.commit) && manifest.platform === PLATFORM && manifest.bundle === ASSETS.bundle &&
    Number.isSafeInteger(manifest.nodeAbi) && manifest.nodeAbi > 0 && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_BUNDLE &&
    digest(manifest.sha256) && typeof manifest.automatic === 'boolean' && Array.isArray(manifest.from) && manifest.from.length <= 64 &&
    new Set(manifest.from).size === manifest.from.length && manifest.from.every(v => TARGET.test(v) && compare(v, tag) < 0), 'Invalid build manifest');
}
function verifyCI(run, jobs, commit) {
  requireGate(run?.head_sha === commit && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success' &&
    run.path?.split('@')[0] === '.github/workflows/ci.yml' && run.head_repository?.full_name === REPO, 'Exact commit CI did not succeed');
  for (const name of REQUIRED_CI) {
    const job = jobs.find(j => j.name === name);
    requireGate(job?.status === 'completed' && job.conclusion === 'success', `Required CI job did not succeed: ${name}`);
  }
}
function verifyRehearsals(manifest, wire, publicKeyPem, now = Date.now()) {
  if (!manifest.automatic) return;
  requireGate(typeof wire === 'string' && wire.length > 0 && wire.length <= 48000 && typeof publicKeyPem === 'string' && publicKeyPem.length, 'Missing signed OpenRC rehearsal receipt');
  const [encoded, sig, extra] = wire.split('.');
  requireGate(!extra && /^[A-Za-z0-9_-]+$/.test(encoded || '') && /^[A-Za-z0-9_-]{86}$/.test(sig || ''), 'Malformed OpenRC rehearsal receipt');
  const body = Buffer.from(encoded, 'base64url'), key = crypto.createPublicKey(publicKeyPem);
  requireGate(key.asymmetricKeyType === 'ed25519' && crypto.verify(null, body, key, Buffer.from(sig, 'base64url')), 'Untrusted OpenRC rehearsal receipt');
  const receipt = JSON.parse(body);
  for (const key of ['repository', 'tag', 'commit', 'sha256', 'platform', 'nodeAbi']) {
    requireGate(receipt[key] === manifest[key], `OpenRC rehearsal does not match package: ${key}`);
  }
  const age = now - Date.parse(receipt.completedAt);
  requireGate(Number.isFinite(age) && age >= -300000 && age < 30 * 86400000 && Array.isArray(receipt.runs) &&
    manifest.from.length > 0 && receipt.runs.length === manifest.from.length, 'Incomplete or expired OpenRC rehearsal');
  for (const from of manifest.from) {
    const matches = receipt.runs.filter(item => item?.from === from);
    const run = matches[0];
    requireGate(matches.length === 1 && REQUIRED_REHEARSALS.every(name => run[name] === 'passed') && digest(run.evidenceSha256),
      `Missing passing upgrade/rollback/restart rehearsal: ${from}`);
  }
}
async function githubGate({ manifest, tag, buildRunId, receipt, key, api, policy }) {
  validateBuildManifest(manifest, tag);
  requireGate(['manual','automatic'].includes(policy) && manifest.automatic === (policy === 'automatic'), 'Publish policy differs from the reviewed build');
  requireGate(/^\d{1,20}$/.test(buildRunId || ''), 'Invalid build run ID');
  const prefix = `/repos/${REPO}`;
  const repo = await api(prefix);
  const build = await api(`${prefix}/actions/runs/${buildRunId}`);
  requireGate(build?.path?.split('@')[0] === '.github/workflows/app-release.yml' && build.event === 'workflow_dispatch' &&
    build.status === 'completed' && build.conclusion === 'success' && build.head_repository?.full_name === REPO && build.head_branch === repo.default_branch,
  'Build artifact was not produced by a successful release workflow on the default branch');
  const { jobs: buildJobs } = await api(`${prefix}/actions/runs/${buildRunId}/attempts/${build.run_attempt}/jobs?per_page=100`);
  requireGate(buildJobs?.some(job => job.name === 'alpine-test-and-build' && job.status === 'completed' && job.conclusion === 'success'),
    'No successful Alpine build job for this artifact');
  let ref = (await api(`${prefix}/git/ref/tags/${tag}`)).object;
  for (let n = 0; ref?.type === 'tag' && n < 4; n++) ref = (await api(`${prefix}/git/tags/${ref.sha}`)).object;
  requireGate(ref?.type === 'commit' && ref.sha === manifest.commit, 'Release tag no longer matches build commit');
  const branch = await api(`${prefix}/compare/${manifest.commit}...${encodeURIComponent(repo.default_branch)}`);
  requireGate(['ahead', 'identical'].includes(branch.status), 'Release commit must belong to the default branch');
  const { workflow_runs: runs } = await api(`${prefix}/actions/workflows/ci.yml/runs?head_sha=${manifest.commit}&event=push&per_page=1`);
  requireGate(runs?.length, 'No CI run found for the exact release commit');
  const run = runs[0];
  const { jobs } = await api(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  verifyCI(run, jobs || [], manifest.commit);
  verifyRehearsals(manifest, receipt, key);
}
if (require.main === module) {
  const api = async path => {
    const response = await fetch(`https://api.github.com${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
      'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'User-Agent': 'mail-aggregator-release-gate', 'Accept': 'application/vnd.github+json',
    } });
    if (!response.ok) throw new Error(`GitHub release gate query failed (${response.status})`);
    return response.json();
  };
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  githubGate({ manifest, tag: process.env.RELEASE_TAG, buildRunId: process.env.BUILD_RUN_ID, receipt: process.env.REHEARSAL_RECEIPT,
    key: process.env.REHEARSAL_KEY, policy: process.env.RELEASE_POLICY, api }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { githubGate, validateBuildManifest, verifyCI, verifyRehearsals, REQUIRED_CI };
