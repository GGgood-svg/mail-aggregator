#!/usr/bin/env node
// 供 install.sh --full 调用的命令行入口:密码通过stdin传进来(不经过argv),
// 输出生成的哈希到stdout。
//
// 用法: printf '%s' "$PASSWORD" | node cli-dovecot-hash.js
//
// 这个脚本和 server/dovecot.js(Web修改密码用的模块)调用的是完全同一个
// generateDovecotHash() 实现(定义在 ./doveadmHash.js),不是shell和Node
// 各自维护一份平行的哈希生成逻辑。
//
// 故意不require ./db,避免在项目文件还没完整部署到位、或者调用时机early于
// 数据目录初始化的时候,意外触发SQLite建库副作用。
const { generateDovecotHash } = require('./doveadmHash');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  // stdin可能带一个尾随换行(比如用printf '%s\n'或者echo喂进来的),去掉,
  // 但只去掉末尾的换行,不动密码中间可能出现的任何字符
  const password = input.replace(/\r?\n+$/, '');
  if (!password) {
    process.stderr.write('ERROR: 没有从stdin读到密码\n');
    process.exit(1);
  }
  try {
    const hash = await generateDovecotHash(password);
    process.stdout.write(hash + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    process.exit(1);
  }
});
