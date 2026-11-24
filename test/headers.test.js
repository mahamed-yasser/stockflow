'use strict';
// Runs in its own process (node --test), so the env var below does not leak into other test files.
process.env.COOKIE_SECURE = '1';
const test = require('node:test'), assert = require('node:assert');
const C = require('../core'), { createApp } = require('../server');

test('session cookie is Secure when COOKIE_SECURE=1, and responses carry anti-framing headers', async () => {
  const db = C.open(':memory:'), srv = createApp(db);
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/setup`, { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'a-long-test-password' }) });
    assert.strictEqual(r.status, 201);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /; Secure/);
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
  } finally { srv.close(); }
});
