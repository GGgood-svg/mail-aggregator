'use strict';

const { createMaildirBackup, verifyMaildirBackup, rehearseMaildirBackup } = require('./maildir-backup');

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'create' && rest.length >= 4) {
    const [source, directory, passphrase, ...flags] = rest;
    let stableSource = false, keep;
    while (flags.length) {
      const flag = flags.shift();
      if (flag === '--stable-source') stableSource = true;
      else if (flag === '--keep' && flags.length && /^\d+$/.test(flags[0])) keep = Number(flags.shift());
      else throw new Error('无效的备份参数');
    }
    return createMaildirBackup({ source, directory, passphrase, stableSource, keep });
  }
  if (command === 'verify' && rest.length === 2) return verifyMaildirBackup({ archive: rest[0], passphrase: rest[1] });
  if (command === 'rehearse' && rest.length === 3) return rehearseMaildirBackup({ archive: rest[0], directory: rest[1], passphrase: rest[2] });
  throw new Error('用法: create <Maildir快照> <备份目录> <口令文件> --stable-source [--keep N] | verify <备份文件> <口令文件> | rehearse <备份文件> <演练父目录> <口令文件>');
}

if (require.main === module) {
  process.umask(0o077);
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { main };
