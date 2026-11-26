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

test('unified unread and batch controls have translations in every non-Chinese locale', () => {
  const terms = ['选择本页', '选择邮件', '添加星标', '取消星标', '统一未读', '封未读邮件（按文件夹统计）',
    '查看该文件夹未读', '文件夹加载失败，请刷新后重试', '没有未读邮件', '邮件加载失败，请刷新后重试',
    '部分邮件操作失败，请刷新后重试', '邮件操作已完成', '批量任务状态暂不可用，请刷新后检查', '批量标记进行中',
    '个文件夹', '已确认邮件', '批量任务部分完成，请检查失败文件夹', '批量任务已完成',
    '等待配置凭据', '等待当前任务完成', '等待调度', '下次同步'];
  for (const locale of locales.filter(item => item !== 'zh-CN')) {
    const { translations } = JSON.parse(fs.readFileSync(path.join(web, 'i18n', `${locale}.json`), 'utf8'));
    for (const term of terms) assert.ok(translations[term], `${locale}: missing ${term}`);
  }
});

test('cross-folder search controls have translations in every non-Chinese locale', () => {
  const terms = ['日期按收取日期筛选；正文搜索可能较慢。', '搜索范围', '当前文件夹', '所有可访问文件夹',
    '收件人', '正文', '正文关键词', '大于（MB）', '小于（MB）', '跨文件夹搜索', '已检查文件夹',
    '查看该文件夹全部结果', '文件夹搜索或加载失败', '重试本页', '本组没有结果，可继续下一页',
    '本组没有符合条件的邮件', '请至少填写一个搜索条件', '邮箱访问权限已变化，请重新搜索', '邮箱已重建，请刷新邮件列表',
    '邮件大小必须是 1 至 4095 MB 的整数', '大小下限必须小于上限', '搜索文字不合法或超过200个字符', '邮箱搜索失败，请稍后重试', '分页游标不合法',
    '跨文件夹搜索每页检查最多8个文件夹，每个文件夹先显示5封。', '搜索参数不合法'];
  for (const locale of locales.filter(item => item !== 'zh-CN')) {
    const { translations } = JSON.parse(fs.readFileSync(path.join(web, 'i18n', `${locale}.json`), 'utf8'));
    for (const term of terms) assert.ok(translations[term], `${locale}: missing ${term}`);
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

test('saved searches, starred view and storage states are translated in all six non-Chinese locales', () => {
  const terms = ['星标状态', '有星标', '无星标', '保存搜索', '更新当前搜索', '智能文件夹', '星标邮件', '搜索名称',
    '智能文件夹仅保存筛选条件，不复制邮件。', '文件夹不可用', '重命名搜索', '删除搜索', '尚未保存搜索',
    '确认删除这个保存的搜索？邮件不会被删除。', '保存的搜索文件夹已不存在或无权访问，请编辑搜索范围。',
    '根分区可用', '空间或 inode 不足', '容量检查繁忙', '容量未知', '安全余量', '可用空间', '可用 inode', '不适用',
    '每个用户最多保存50个搜索', '搜索名称需为1至80个字符', '邮件解析繁忙或暂时不可用，请稍后重试',
    '单个文件夹', '编辑搜索', '应用与邮件存储空间', '检查邮件盘、inode、helper 和磁盘安全余量。',
    '旧备份保留当前搜索', '已恢复搜索', '已跳过搜索'];
  for (const locale of locales.filter(item => item !== 'zh-CN')) {
    const { translations } = JSON.parse(fs.readFileSync(path.join(web, 'i18n', `${locale}.json`), 'utf8'));
    for (const term of terms) assert.ok(translations[term], `${locale}: missing ${term}`);
  }
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
