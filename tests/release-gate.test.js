'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { REPO, PROTOCOL, PLATFORM, ASSETS } = require('../scripts/updater/release');
const { githubGate, verifyRehearsals, REQUIRED_CI } = require('../scripts/updater/release-gate');
const { parseWebConfig, shellExports } = require('../scripts/updater/web-config');
const { historyPage } = require('../scripts/updater/history');

const tag = 'v1.0.0', commit = 'a'.repeat(40), sha256 = 'b'.repeat(64);
const manifest = { repository: REPO, protocol: PROTOCOL, tag, commit, sha256, platform: PLATFORM, nodeAbi: 137,
  bundle: ASSETS.bundle, bytes: 24000, from: ['v0.9.0','v0.9.1'], automatic: true };
const keys = crypto.generateKeyPairSync('ed25519');
const key = keys.publicKey.export({ type: 'spki', format: 'pem' });
const passing = from => ({ from, cutover:'passed', rollback:'passed', restartRecovery:'passed', evidenceSha256:'c'.repeat(64) });
function receipt(change = {}) {
  const body = Buffer.from(JSON.stringify({ ...manifest, completedAt: new Date().toISOString(), runs: manifest.from.map(passing), ...change }));
  return `${body.toString('base64url')}.${crypto.sign(null, body, keys.privateKey).toString('base64url')}`;
}

test('automatic signing requires a matching successful upgrade, rollback and restart receipt for every source version', () => {
  assert.doesNotThrow(() => verifyRehearsals(manifest,receipt(),key));
  assert.throws(() => verifyRehearsals(manifest,receipt({ sha256: 'd'.repeat(64) }),key), /does not match package/);
  assert.throws(() => verifyRehearsals(manifest,receipt({ runs: [passing('v0.9.0'),passing('v0.9.0')] }),key), /Missing passing/);
  assert.throws(() => verifyRehearsals(manifest,receipt({ runs: [passing('v0.9.0'),{ ...passing('v0.9.1'), rollback:'failed' }] }),key), /Missing passing/);
  assert.throws(() => verifyRehearsals(manifest,'',key), /Missing signed/);
});

test('publishing fails closed on a moved tag, missing CI matrix job, mismatched policy, or non-build workflow', async () => {
  const completed = { status:'completed',conclusion:'success' }, repository = { full_name: REPO };
  const source = `/repos/${REPO}`;
  async function run({ moved = false, missing = false, policy = 'automatic', wrongJob = false } = {}) {
    return githubGate({ manifest, tag, key, receipt: receipt(), buildRunId: '100', policy, api: async request => {
      const url = request.slice(source.length);
      if (!url) return { default_branch: 'main' };
      if (url === '/actions/runs/100') return { ...completed, path: '.github/workflows/app-release.yml',event:'workflow_dispatch', head_branch:'main',head_repository:repository,run_attempt:1 };
      if (url === '/actions/runs/100/attempts/1/jobs?per_page=100') return { jobs: [{ ...completed, name: wrongJob ? 'sign-and-publish' : 'alpine-test-and-build' }] };
      if (url === `/git/ref/tags/${tag}`) return { object: { type:'commit', sha: moved ? 'f'.repeat(40) : commit } };
      if (url === `/compare/${commit}...main`) return { status:'ahead' };
      if (url === `/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&per_page=1`) return { workflow_runs: [{ ...completed, id: 101, run_attempt: 1, head_sha: commit, head_repository: repository, path: '.github/workflows/ci.yml', event:'push' }] };
      assert.equal(url,'/actions/runs/101/attempts/1/jobs?per_page=100');
      return { jobs: REQUIRED_CI.slice(missing ? 1 : 0).map(name => ({ ...completed, name })) };
    } });
  }
  await run();
  await assert.rejects(run({ moved:true }), /tag no longer matches/);
  await assert.rejects(run({ missing:true }), /Required CI job/);
  await assert.rejects(run({ policy:'manual' }), /policy differs/);
  await assert.rejects(run({ wrongJob:true }), /No successful Alpine build/);
});

test('OpenRC and update preflight parse the same installer configuration', () => {
  const config = parseWebConfig(`# installation\nexport MAIL_AGG_BIND_HOST='127.0.0.1' # inline comment\nPORT="8181"\nWEB_PORT=8080\nMAIL_AGG_SECURITY_PROFILE=trusted-lan\n`);
  assert.deepEqual(config, { MAIL_AGG_BIND_HOST:'127.0.0.1',PORT:'8181',WEB_PORT:'8080',MAIL_AGG_SECURITY_PROFILE:'trusted-lan' });
  assert.match(shellExports(config), /export PORT='8181'/);
  assert.throws(() => parseWebConfig('PORT="unterminated'),/Invalid runtime configuration/);
});

test('history is paginated and keeps updater response below the byte budget', () => {
  const items = Array.from({ length: 60 }, (_, index) => ({ operationId:crypto.randomUUID(), from:'0.9.0', to:'1.0.0',
    outcome:'rollback_verified', source:'manual', at:index, internal:'秘'.repeat(15000) }));
  const result = historyPage(items, 2, 420);
  assert.deepEqual(result.pagination,{page:2,pageSize:20,total:60,totalPages:3});
  assert.equal(result.items[0].at,20);
  assert.equal(Object.hasOwn(result.items[0],'internal'),false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
});
