const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE'];

test('all supported locale packs are valid and non-empty where required', () => {
  for (const locale of locales) {
    const filename = path.join(web, 'i18n', `${locale}.json`);
    assert.ok(fs.existsSync(filename), `missing ${locale}`);
    const pack = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(typeof pack.language, 'string');
    assert.equal(typeof pack.translations, 'object');
    if (locale !== 'zh-CN') {
      assert.ok(Object.keys(pack.translations).length >= 25, `${locale} pack is too small`);
      for (const [source, translated] of Object.entries(pack.translations)) {
        assert.ok(source.trim());
        assert.ok(String(translated).trim(), `${locale}: empty translation for ${source}`);
      }
    }
  }
});

test('every web page loads the i18n runtime', () => {
  const pages = fs.readdirSync(web).filter((name) => name.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(web, page), 'utf8');
    assert.match(html, /<script src="\/js\/i18n\.js"><\/script>/, page);
  }
});

test('English fallback covers critical navigation, actions, and safety warnings', () => {
  const english = JSON.parse(fs.readFileSync(path.join(web, 'i18n', 'en-US.json'), 'utf8')).translations;
  const critical = [
    '查看邮件', '邮箱账号', '同步日志', '设置', '系统信息', '退出登录',
    '保存', '删除', '立即同步', '测试连接', '执行安全恢复',
    '卸载程序（保留邮件）', '彻底卸载并删除邮件',
    '镜像模式会永久删除本地目标端中源端已不存在的邮件，但绝不会删除源邮箱邮件。仅账号隔离模式可用。',
  ];
  for (const source of critical) assert.ok(english[source], `missing English translation: ${source}`);
});

test('English fallback covers every static Chinese Web text and placeholder', () => {
  const english = JSON.parse(fs.readFileSync(path.join(web, 'i18n', 'en-US.json'), 'utf8')).translations;
  const missing = [];
  for (const page of fs.readdirSync(web).filter((name) => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(web, page), 'utf8')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    const candidates = [];
    for (const match of html.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</g)) candidates.push(match[1]);
    for (const match of html.matchAll(/(?:placeholder|title|aria-label)="([^"]*[\u3400-\u9fff][^"]*)"/g)) candidates.push(match[1]);
    for (const candidate of candidates) {
      const source = candidate.replace(/&#10;/g, ' ').replace(/\s+/g, ' ').trim();
      if (source && !english[source]) missing.push(`${page}: ${source}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('dynamic user-visible account data is excluded from automatic translation', () => {
  const runtime = fs.readFileSync(path.join(web, 'js', 'i18n.js'), 'utf8');
  assert.match(runtime, /closest\('\[data-i18n-skip\]'\)/);
  for (const page of ['accounts.html', 'logs.html', 'index.html']) {
    const html = fs.readFileSync(path.join(web, page), 'utf8');
    assert.match(html, /data-i18n-skip/, `${page} does not mark user content`);
  }
});

test('server and installer expose the same supported locale list', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
  for (const locale of locales) {
    assert.ok(server.includes(locale), `server missing ${locale}`);
    assert.ok(installer.includes(locale), `installer missing ${locale}`);
  }
});
