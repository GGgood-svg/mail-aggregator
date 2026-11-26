#!/usr/bin/env node
'use strict';

const { dataPaths } = require('./data-paths');
const { offlineDiagnostics } = require('./diagnostics');

offlineDiagnostics(dataPaths()).then(report => {
  console.log(JSON.stringify(report, null, 2));
}).catch(() => {
  console.error('无法读取离线诊断，请检查 Node.js 与应用数据目录权限');
  process.exitCode = 1;
});
