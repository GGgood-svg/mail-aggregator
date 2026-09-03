const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateDovecotHash } = require('../server/doveadmHash');

function fakeChild(run) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (input) => run(child, input);
  return child;
}

test('generates a hash without exposing the password in process arguments', async () => {
  let invocation;
  const password = 'private-password';
  const hash = await generateDovecotHash(password, 'SHA512-CRYPT', {
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return fakeChild((child, input) => process.nextTick(() => {
        assert.equal(input, `${password}\n${password}\n`);
        child.stderr.emit('data', 'Enter new password: Retype new password: ');
        child.stdout.emit('data', '{SHA512-CRYPT}$6$generated');
        child.emit('close', 0, null);
      }));
    },
  });

  assert.equal(hash, '{SHA512-CRYPT}$6$generated');
  assert.equal(invocation.command, 'doveadm');
  assert.deepEqual(invocation.args, ['-O', 'pw', '-s', 'SHA512-CRYPT']);
  assert.equal(invocation.args.includes(password), false);
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('an asynchronous stdin EPIPE rejects without becoming an unhandled event', async () => {
  await assert.rejects(
    generateDovecotHash('private-password', 'SHA512-CRYPT', {
      spawnImpl() {
        return fakeChild((child) => process.nextTick(() => {
          const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
          child.stdin.emit('error', error);
          child.stderr.emit('data', 'Unknown password scheme');
          child.emit('close', 75, null);
        }));
      },
    }),
    /退出码 75.*Unknown password scheme.*stdin EPIPE/
  );
});

test('spawn failures and output without a hash return useful errors', async () => {
  await assert.rejects(
    generateDovecotHash('private-password', 'SHA512-CRYPT', {
      spawnImpl() { throw new Error('not installed'); },
    }),
    /无法启动 doveadm: not installed/
  );

  await assert.rejects(
    generateDovecotHash('private-password', 'SHA512-CRYPT', {
      spawnImpl() {
        return fakeChild((child) => process.nextTick(() => {
          child.emit('close', 0, null);
        }));
      },
    }),
    /生成密码哈希失败/
  );
});
