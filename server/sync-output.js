// imapsync output parsing is kept dependency-free so it can be tested without
// SQLite, Dovecot, or a real imapsync process.
function parseSummary(output) {
  const text = String(output || '');
  const grabInt = (re) => {
    const match = text.match(re);
    return match ? parseInt(match[1], 10) : null;
  };

  // imapsync 2.290 no longer prints the old "HostN Nb messages/folders"
  // summary lines. Reconstruct the same totals from its per-folder SELECT
  // diagnostics, de-duplicating folder names in case a retry repeats a line.
  const folderTotals = (host) => {
    const totals = new Map();
    const pattern = new RegExp(`Host${host}:\\s+folder\\s+\\[(.*)\\]\\s+has\\s+(\\d+)\\s+messages\\s+in\\s+total`, 'gi');
    let match;
    while ((match = pattern.exec(text))) totals.set(match[1], parseInt(match[2], 10));
    if (!totals.size) return null;
    return { messages: [...totals.values()].reduce((sum, value) => sum + value, 0), folders: totals.size };
  };
  const host1Fallback = folderTotals(1);
  const host2Fallback = folderTotals(2);

  return {
    host1Messages: grabInt(/Host1\s+Nb\s+messages\s*:\s*(\d+)/i) ?? host1Fallback?.messages ?? null,
    host2Messages: grabInt(/Host2\s+Nb\s+messages\s*:\s*(\d+)/i) ?? host2Fallback?.messages ?? null,
    host1Folders: grabInt(/Host1\s+Nb\s+folders\s*:\s*(\d+)/i) ?? host1Fallback?.folders ?? null,
    host2Folders: grabInt(/Host2\s+Nb\s+folders\s*:\s*(\d+)/i) ?? host2Fallback?.folders ?? null,
    messagesTransferred: grabInt(/Messages\s+transferred\s*:\s*(\d+)/i),
    messagesSkipped: grabInt(/Messages\s+skipped\s*:\s*(\d+)/i),
    errors: grabInt(/Detected\s+(\d+)\s+errors?/i),
  };
}

function categorizeTestError(combinedOutput, timedOut) {
  if (timedOut) {
    return { category: 'timeout', message: '连接超时(60秒内未完成)' };
  }
  const text = combinedOutput || '';
  if (/certificate|ssl|tls|handshake/i.test(text)) {
    return { category: 'tls_failed', message: 'TLS连接失败,请检查服务器地址/端口/SSL设置' };
  }
  if (/login|auth|password|credential|LOGIN\s+fail/i.test(text)) {
    return { category: 'auth_failed', message: 'IMAP认证失败,请检查用户名和授权码/密码' };
  }
  if (/connection refused|network is unreachable|no route to host|could not connect|econnrefused/i.test(text)) {
    return { category: 'network_unreachable', message: '网络连接失败,无法到达该IMAP服务器' };
  }
  if (/folder|mailbox/i.test(text)) {
    return { category: 'folder_failed', message: '登录成功但获取文件夹列表失败' };
  }
  return { category: 'unknown', message: '连接失败,请查看详细日志' };
}

module.exports = { parseSummary, categorizeTestError };
