const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIntegerInRange,
  normalizeHost,
  isValidHost,
  normalizeSystemUsername,
  isValidSystemUsername,
  isValidSecret,
} = require('../server/validation');
const { validateAccountPayload } = require('../server/account-validation');

const providers = {
  custom: { host: '', port: 993, ssl: true, auth_type: 'password' },
  qq: { host: 'imap.qq.com', port: 993, ssl: true, auth_type: 'password' },
  gmail_app_password: { host: 'imap.gmail.com', port: 993, ssl: true, auth_type: 'password' },
  gmail: { host: 'imap.gmail.com', port: 993, ssl: true, auth_type: 'oauth2' },
  outlook: { host: 'outlook.office365.com', port: 993, ssl: true, auth_type: 'oauth2' },
};
const getProvider = (key) => providers[key] || null;

test('provider quick links are HTTPS-only and cover credential-based presets', () => {
  const configured = require('../config/providers.json');
  for (const [key, provider] of Object.entries(configured)) {
    const links = provider.help_links || [];
    if (provider.auth_type === 'password' && key !== 'custom') {
      assert.ok(links.length > 0, `${key} should have a credential shortcut`);
    }
    for (const link of links) {
      assert.ok(String(link.label || '').trim(), `${key} shortcut needs a label`);
      assert.equal(new URL(link.url).protocol, 'https:', `${key} shortcut must use HTTPS`);
    }
  }
  assert.equal(configured.gmail_app_password.help_links[0].url, 'https://myaccount.google.com/apppasswords');
  assert.equal(configured.custom.help_links, undefined);
});

function validate(body, requireSecret = true) {
  return validateAccountPayload(body, {
    requireSecret,
    getProvider,
    defaultLocalUser: 'mailuser',
  });
}

test('parseIntegerInRange accepts only complete integers inside the range', () => {
  assert.equal(parseIntegerInRange(' 993 ', 1, 65535), 993);
  assert.equal(parseIntegerInRange(60, 60, 600), 60);
  for (const value of ['', '12x', '1.5', '0x10', '1e2', true, 0, 65536, null, undefined]) {
    assert.equal(parseIntegerInRange(value, 1, 65535), null, String(value));
  }
});

test('host validation accepts DNS, localhost, IPv4, and IPv6 but rejects URLs and malformed labels', () => {
  for (const host of ['imap.example.com', 'localhost', '127.0.0.1', '::1', 'mail-server.local.']) {
    assert.equal(isValidHost(host), true, host);
  }
  for (const host of ['', 'https://imap.example.com', 'bad host', '-bad.example', 'bad-.example', 'a/b']) {
    assert.equal(isValidHost(host), false, host);
  }
  assert.equal(isValidHost(123), false);
  assert.equal(normalizeHost('  imap.example.com  '), 'imap.example.com');
});

test('system usernames reject privileged and malformed accounts', () => {
  for (const username of ['mailuser', '_mail', 'mail-user']) {
    assert.equal(isValidSystemUsername(username), true, username);
  }
  for (const username of ['root', 'daemon', 'MailUser', 'bad user', '']) {
    assert.equal(isValidSystemUsername(username), false, username);
  }
  assert.equal(normalizeSystemUsername('  mailuser  '), 'mailuser');
});

test('secret validation rejects empty, oversized, multiline, and NUL-containing values', () => {
  assert.equal(isValidSecret('app-password-123'), true);
  assert.equal(isValidSecret(''), false);
  assert.equal(isValidSecret('a'.repeat(4097)), false);
  assert.equal(isValidSecret('line1\nline2'), false);
  assert.equal(isValidSecret('bad\0secret'), false);
});

test('valid custom account payload is normalized for database storage', () => {
  const result = validate({
    name: '  Personal Mail  ',
    provider: 'custom',
    host: '  imap.example.com ',
    port: '993',
    ssl: true,
    username: ' user@example.com ',
    secret: 'app-password',
    enabled: false,
    sync_interval: '600',
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.normalized, {
    name: 'Personal Mail',
    provider: 'custom',
    host: 'imap.example.com',
    port: 993,
    ssl: 1,
    username: 'user@example.com',
    auth_type: 'password',
    enabled: 0,
    sync_interval: 600,
    local_user: 'mailuser',
    sync_mode: 'full',
    destination_mode: 'flat',
    destination_folder: null,
    folder_includes: '',
    folder_excludes: '',
    max_age_days: null,
    max_size_mb: null,
    deletion_mode: 'archive',
  });
});

test('provider presets fill connection defaults on the backend', () => {
  const result = validate({
    name: 'QQ',
    provider: 'qq',
    username: '12345@qq.com',
    secret: 'authorization-code',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.host, 'imap.qq.com');
  assert.equal(result.normalized.port, 993);
  assert.equal(result.normalized.ssl, 1);

  const gmail = validate({
    name: 'Personal Gmail',
    provider: 'gmail_app_password',
    username: 'user@gmail.com',
    secret: 'google-app-password',
  });
  assert.deepEqual(gmail.errors, []);
  assert.equal(gmail.normalized.host, 'imap.gmail.com');
  assert.equal(gmail.normalized.auth_type, 'password');

  const forged = validate({
    name: 'Forged QQ', provider: 'qq', host: 'attacker.example', port: 143,
    ssl: false, auth_type: 'oauth2', username: '12345@qq.com', secret: 'authorization-code',
  });
  assert.deepEqual(forged.errors, []);
  assert.equal(forged.normalized.host, 'imap.qq.com');
  assert.equal(forged.normalized.port, 993);
  assert.equal(forged.normalized.ssl, 1);
  assert.equal(forged.normalized.auth_type, 'password');
});

test('custom IMAP rejects plaintext and literal private or reserved destinations', () => {
  const base = { name: 'Private', provider: 'custom', port: 993, ssl: true,
    username: 'user@example.com', secret: 'secret' };
  for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1']) {
    assert.match(validate({ ...base, host }).errors.join('; '), /不能指向/);
  }
  assert.match(validate({ ...base, host: 'imap.example.com', ssl: false }).errors.join('; '), /必须使用SSL\/TLS/);
});

test('account validation rejects malformed ranges, types, enums, and secrets', () => {
  const result = validate({
    name: 'x'.repeat(101),
    provider: 'custom',
    host: 'https://imap.example.com',
    port: '993x',
    ssl: 'true',
    username: 'user@example.com',
    secret: 'line1\nline2',
    enabled: 'yes',
    sync_interval: 10,
    local_user: 'root',
    sync_mode: 'delete-everything',
  });

  const message = result.errors.join('; ');
  for (const expected of [
    '名称不能超过100个字符',
    'IMAP服务器地址格式不合法',
    'IMAP端口必须是1-65535之间的整数',
    'SSL设置必须是布尔值',
    '启用状态必须是布尔值',
    '同步间隔必须是60-604800秒之间的整数',
    '本地目标用户格式不合法',
    '当前仅支持full同步模式',
    '密码/授权码必填',
  ]) {
    assert.match(message, new RegExp(expected));
  }
});

test('Gmail and Microsoft OAuth2 accounts do not require a password payload', () => {
  const result = validate({
    name: 'Gmail',
    provider: 'gmail',
    username: 'user@gmail.com',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.auth_type, 'oauth2');

  const outlook = validate({ name: 'Work', provider: 'outlook', username: 'user@example.com' });
  assert.deepEqual(outlook.errors, []);
  assert.equal(outlook.normalized.auth_type, 'oauth2');
});

test('editing may omit an existing secret but validates any replacement', () => {
  const base = {
    name: 'Existing',
    provider: 'custom',
    host: 'imap.example.com',
    port: 993,
    ssl: true,
    username: 'user@example.com',
    sync_interval: 600,
  };
  assert.deepEqual(validate({ ...base, secret: '' }, false).errors, []);
  assert.match(validate({ ...base, secret: 'bad\nvalue' }, false).errors.join('; '), /不能包含换行/);
});

test('editing preserves the existing local target user when the field is omitted', () => {
  const result = validateAccountPayload({
    name: 'Existing',
    provider: 'custom',
    host: 'imap.example.com',
    port: 993,
    ssl: true,
    username: 'user@example.com',
    sync_interval: 600,
  }, {
    requireSecret: false,
    getProvider,
    defaultLocalUser: 'archiveuser',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.local_user, 'archiveuser');
});

test('account isolation validates and normalizes a portable destination folder', () => {
  const base = {
    name: 'QQ', provider: 'qq', username: '12345@qq.com', secret: 'authorization-code',
    destination_mode: 'subfolder',
  };
  const valid = validate({ ...base, destination_folder: '  我的   QQ邮箱 ' });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.normalized.destination_mode, 'subfolder');
  assert.equal(valid.normalized.destination_folder, '我的 QQ邮箱');

  assert.match(validate({ ...base, destination_folder: 'QQ/INBOX' }).errors.join('; '), /隔离文件夹名称/);
  assert.match(validate({ ...base, destination_mode: 'unknown', destination_folder: 'QQ' }).errors.join('; '), /目标文件夹策略无效/);
});

test('editing preserves the existing destination strategy when fields are omitted', () => {
  const result = validateAccountPayload({
    name: 'Existing', provider: 'custom', host: 'imap.example.com', port: 993,
    ssl: true, username: 'user@example.com', sync_interval: 600,
  }, {
    requireSecret: false,
    getProvider,
    defaultLocalUser: 'mailuser',
    defaultDestinationMode: 'subfolder',
    defaultDestinationFolder: 'Archive Mail',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.destination_mode, 'subfolder');
  assert.equal(result.normalized.destination_folder, 'Archive Mail');
});

test('advanced sync rules are normalized and unsafe mirror combinations are rejected', () => {
  const base = {
    name: 'Archive', provider: 'custom', host: 'imap.example.com', port: 993,
    ssl: true, username: 'user@example.com', secret: 'secret', sync_interval: 600,
    destination_mode: 'subfolder', destination_folder: 'Archive',
  };
  const valid = validate({
    ...base,
    folder_includes: ' INBOX\nSent\nINBOX ',
    folder_excludes: 'Trash',
    max_age_days: '365',
    max_size_mb: '50',
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.normalized.folder_includes, 'INBOX\nSent');
  assert.equal(valid.normalized.folder_excludes, 'Trash');
  assert.equal(valid.normalized.max_age_days, 365);
  assert.equal(valid.normalized.max_size_mb, 50);

  const unsafe = validate({ ...base, deletion_mode: 'mirror_messages', max_age_days: 30 });
  assert.match(unsafe.errors.join('; '), /不能与时间或邮件大小限制同时启用/);
});
