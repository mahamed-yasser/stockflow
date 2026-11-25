'use strict';
const test = require('node:test'), assert = require('node:assert');
const C = require('../core'), { createApp } = require('../server');

test('change password: checks current, enforces rules, signs out other sessions, writes audit', () => {
  const db = C.open(); C.createUser(db, 'owner', 'first-password-1');
  const t1 = C.login(db, 'owner', 'first-password-1'), t2 = C.login(db, 'owner', 'first-password-1');
  const id = C.sessionUser(db, t1).id;
  assert.throws(() => C.changePassword(db, id, 'wrong-password-x', 'second-password-2', t1), e => e.status === 403);
  assert.throws(() => C.changePassword(db, id, 'first-password-1', 'short', t1), /at least 10/);
  assert.throws(() => C.changePassword(db, id, 'first-password-1', 'first-password-1', t1), /different/);
  C.changePassword(db, id, 'first-password-1', 'second-password-2', t1);
  assert.ok(C.sessionUser(db, t1)); assert.strictEqual(C.sessionUser(db, t2), null);
  assert.strictEqual(C.login(db, 'owner', 'first-password-1'), null); assert.ok(C.login(db, 'owner', 'second-password-2'));
  assert.deepStrictEqual(C.listAudit(db).map(a => a.action), ['password_changed']);
});

test('http: password endpoint and audit log need a session; login and writes are logged', async () => {
  const db = C.open(), srv = createApp(db); await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.strictEqual((await fetch(base + '/api/audit')).status, 401);
    const s = await fetch(base + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'first-password-1' }) });
    const ck = s.headers.get('set-cookie').split(';')[0], H = { cookie: ck };
    await fetch(base + '/api/products', { method: 'POST', headers: H, body: JSON.stringify({ sku: 'A', name: 'Alpha', price: 1 }) });
    const bad = await fetch(base + '/api/password', { method: 'POST', headers: H, body: JSON.stringify({ current: 'nope-nope-nope', next: 'second-password-2' }) });
    assert.strictEqual(bad.status, 403);
    const ok = await fetch(base + '/api/password', { method: 'POST', headers: H, body: JSON.stringify({ current: 'first-password-1', next: 'second-password-2' }) });
    assert.strictEqual(ok.status, 200);
    const a = await (await fetch(base + '/api/audit', { headers: H })).json();
    const acts = a.entries.map(e => e.action);
    assert.ok(acts.includes('write') && acts.includes('password_changed'));
    assert.ok(!JSON.stringify(a).includes('second-password-2') && !JSON.stringify(a).includes('first-password-1'));
  } finally { srv.close(); }
});
