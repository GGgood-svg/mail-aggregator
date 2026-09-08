const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const router = express.Router();
const USERNAME_RE = /^[\p{L}\p{N}_.@-]{2,64}$/u;

router.get('/', (req, res) => {
  const users = db.prepare(`SELECT u.id,u.username,u.role,u.enabled,u.created_at,
    COUNT(a.id) AS account_count FROM admin_users u
    LEFT JOIN accounts a ON a.owner_user_id=u.id
    GROUP BY u.id ORDER BY u.id`).all();
  res.json(users.map((u) => ({ ...u, enabled: !!u.enabled })));
});

router.post('/', (req, res) => {
  const username = String(req.body?.username || '').normalize('NFKC').trim();
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: '用户名需为2-64位字母、数字、中文或 _ . @ -' });
  if (password.length < 10 || password.length > 256) return res.status(400).json({ error: '密码需为10-256位' });
  try {
    const info = db.prepare('INSERT INTO admin_users(username,password_hash,role) VALUES(?,?,?)')
      .run(username, bcrypt.hashSync(password, 12), role);
    res.status(201).json({ id: Number(info.lastInsertRowid), username, role, enabled: true });
  } catch (error) {
    if (String(error.code).includes('SQLITE_CONSTRAINT')) return res.status(409).json({ error: '用户名已存在' });
    throw error;
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const role = req.body?.role === undefined ? user.role : (req.body.role === 'admin' ? 'admin' : 'user');
  const enabled = req.body?.enabled === undefined ? user.enabled : (req.body.enabled ? 1 : 0);
  if (id === Number(req.user.id) && (!enabled || role !== 'admin')) {
    return res.status(400).json({ error: '不能停用自己或取消自己的管理员权限' });
  }
  const password = req.body?.password === undefined ? null : String(req.body.password);
  if (password !== null && (password.length < 10 || password.length > 256)) return res.status(400).json({ error: '新密码需为10-256位' });
  if (id === Number(req.user.id) && password !== null) {
    return res.status(400).json({ error: '修改自己的密码必须验证当前密码，请使用个人密码修改区' });
  }
  const adminCount = db.prepare("SELECT COUNT(*) c FROM admin_users WHERE role='admin' AND enabled=1").get().c;
  if (user.role === 'admin' && user.enabled && (role !== 'admin' || !enabled) && adminCount <= 1) {
    return res.status(400).json({ error: '系统至少需要一个启用的管理员' });
  }
  if (password !== null) {
    db.prepare(`UPDATE admin_users SET role=?,enabled=?,password_hash=?,session_version=session_version+1 WHERE id=?`)
      .run(role, enabled, bcrypt.hashSync(password, 12), id);
  } else {
    db.prepare('UPDATE admin_users SET role=?,enabled=?,session_version=session_version+1 WHERE id=?')
      .run(role, enabled, id);
  }
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) return res.status(400).json({ error: '不能删除当前登录用户' });
  const user = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const count = db.prepare('SELECT COUNT(*) c FROM accounts WHERE owner_user_id=?').get(id).c;
  if (count) return res.status(409).json({ error: '该用户仍有邮箱账号，请先删除或迁移这些账号' });
  db.prepare('DELETE FROM admin_users WHERE id=?').run(id);
  res.json({ ok: true });
});

module.exports = router;
