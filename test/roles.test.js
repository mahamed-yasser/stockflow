'use strict';
const test = require('node:test'), assert = require('node:assert');
const C = require('../core'), { createApp } = require('../server');

test('roles: staff can do daily work but not users, audit, backup or import; passwords stay out of backup', async () => {
  const db = C.open(), srv = createApp(db); await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = (ck, path, method = 'GET', body) => fetch(base + path, { method, headers: { cookie: ck }, body: body && JSON.stringify(body) });
  try {
    const s = await fetch(base + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'owner-password-1' }) });
    const own = s.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await j(own, '/api/users', 'POST', { username: 'clerk', password: 'clerk-password-1' })).status, 201);
    assert.strictEqual((await j(own, '/api/users', 'POST', { username: 'bad', password: 'short' })).status, 400);
    assert.deepStrictEqual(C.listUsers(db).map(u => u.role), ['owner', 'staff']); // default role is staff, setup user is owner
    const l = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'clerk', password: 'clerk-password-1' }) });
    const stf = l.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await j(stf, '/api/products', 'POST', { sku: 'A', name: 'Alpha', price: 2 })).status, 201); // daily work allowed
    for (const [m, p, b] of [['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/backup'], ['POST', '/api/users', { username: 'x12', password: 'long-password-12' }], ['POST', '/api/import', { csv: 'sku,name\nA,B' }]])
      assert.strictEqual((await j(stf, p, m, b)).status, 403, m + ' ' + p);
    assert.strictEqual((await fetch(base + '/api/backup')).status, 401);
    const bk = await (await j(own, '/api/backup')).json();
    assert.strictEqual(bk.products.length, 1); assert.ok(!JSON.stringify(bk).match(/hash|salt|clerk|password/i));
    const audit = (await (await j(own, '/api/audit')).json()).entries;
    assert.ok(audit.some(e => e.username === 'clerk' && e.action === 'write' && e.detail === '/api/products 201'));
    assert.ok(audit.some(e => e.username === 'clerk' && e.detail === '/api/import 403')); // rejected attempts are logged with status
  } finally { srv.close(); }
});
test('existing database without a role column is migrated: the first (setup) account stays owner, any extra account becomes staff', () => {
  const { DatabaseSync } = require('node:sqlite'); const os = require('os'), path = require('path'), fs = require('fs');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), 'old.db'); const d = new DatabaseSync(f);
  d.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL); INSERT INTO users(username,salt,hash) VALUES('old','aa','bb'); INSERT INTO users(username,salt,hash) VALUES('extra','cc','dd')"); d.close();
  assert.deepStrictEqual(C.listUsers(C.open(f)).map(u => u.role), ['owner', 'staff']);
});

test('failed password changes are audited with the reason only, never the passwords', async () => {
  const db = C.open(), srv = createApp(db); await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const s = await fetch(base + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'owner-password-1' }) });
    const ck = s.headers.get('set-cookie').split(';')[0];
    const r = await fetch(base + '/api/password', { method: 'POST', headers: { cookie: ck }, body: JSON.stringify({ current: 'guess-guess-guess', next: 'brand-new-password' }) });
    assert.strictEqual(r.status, 403);
    const e = C.listAudit(db).find(x => x.action === 'password_change_failed');
    assert.ok(e && e.username === 'owner' && e.detail === 'Current password is wrong');
    assert.ok(!JSON.stringify(C.listAudit(db)).match(/guess-guess|brand-new/));
  } finally { srv.close(); }
});
