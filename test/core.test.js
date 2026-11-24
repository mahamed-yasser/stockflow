'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const C = require('../core'), { seed } = require('../seed'), { createApp } = require('../server');
const D = '2026-11-24';
const fresh = () => { const db = C.open(); db.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); return db; };
const prod = (db, over = {}) => C.saveProduct(db, null, { sku: 'A-1', name: 'Widget', price: 10, cost: 4, reorderLevel: 5, openingStock: 20, ...over }, D);

test('stock is the sum of movements, opening stock recorded', () => {
  const db = fresh(); const p = prod(db); assert.strictEqual(p.stock, 20);
  C.receive(db, p.id, 5, 'delivery', D); assert.strictEqual(C.getProduct(db, p.id).stock, 25);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM movements').get().n, 2);
});
test('product validation and SKU uniqueness (case-insensitive)', () => {
  const db = fresh(); prod(db);
  assert.throws(() => prod(db, { sku: 'a-1' }), e => e.status === 409);
  assert.throws(() => prod(db, { sku: 'bad sku!' }), /SKU/); assert.throws(() => prod(db, { sku: 'B', name: 'x' }), /name/);
  assert.throws(() => prod(db, { sku: 'C', price: -1 }), /amount/); assert.throws(() => prod(db, { sku: 'D', reorderLevel: 1.5 }), /whole/);
  assert.throws(() => prod(db, { sku: 'E', openingStock: -3 }), /whole/);
  assert.strictEqual(C.listProducts(db).length, 1);
});
test('order decrements stock, refuses oversell and leaves nothing behind', () => {
  const db = fresh(); const a = prod(db), b = prod(db, { sku: 'B-1', name: 'Gadget', openingStock: 2 });
  const o = C.createOrder(db, { customer: 'Test Buyer', items: [{ productId: a.id, qty: 3 }, { productId: b.id, qty: 2 }] }, D);
  assert.strictEqual(o.total, 3 * 1000 + 2 * 1000); assert.strictEqual(C.getProduct(db, a.id).stock, 17); assert.strictEqual(C.getProduct(db, b.id).stock, 0);
  const before = db.prepare('SELECT count(*) n FROM movements').get().n;
  assert.throws(() => C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 1 }, { productId: b.id, qty: 1 }] }, D), e => e.status === 409 && /Gadget/.test(e.message));
  assert.strictEqual(db.prepare('SELECT count(*) n FROM movements').get().n, before); assert.strictEqual(C.listOrders(db).length, 1);
});
test('same product on two lines is combined for the stock check', () => {
  const db = fresh(); const a = prod(db, { openingStock: 5 });
  assert.throws(() => C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 3 }, { productId: a.id, qty: 3 }] }, D), e => e.status === 409);
});
test('order uses price at time of sale; later price change does not rewrite history', () => {
  const db = fresh(); const a = prod(db); const o = C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 2 }] }, D);
  C.saveProduct(db, a.id, { sku: 'A-1', name: 'Widget', price: 99, cost: 4, reorderLevel: 5 }, D);
  assert.strictEqual(C.getOrder(db, o.id).total, 2000);
});
test('cancel returns stock once; fulfilled orders cannot be cancelled', () => {
  const db = fresh(); const a = prod(db); const o = C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 4 }] }, D);
  C.setOrderStatus(db, o.id, 'cancelled', D); assert.strictEqual(C.getProduct(db, a.id).stock, 20);
  assert.throws(() => C.setOrderStatus(db, o.id, 'cancelled', D), e => e.status === 409); assert.strictEqual(C.getProduct(db, a.id).stock, 20);
  const o2 = C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 1 }] }, D); C.setOrderStatus(db, o2.id, 'fulfilled', D);
  assert.throws(() => C.setOrderStatus(db, o2.id, 'cancelled', D), e => e.status === 409); assert.throws(() => C.setOrderStatus(db, o2.id, 'fulfilled', D), e => e.status === 409);
});
test('inactive products cannot be ordered; validation of orders', () => {
  const db = fresh(); const a = prod(db); C.saveProduct(db, a.id, { sku: 'A-1', name: 'Widget', price: 10, active: false }, D);
  assert.throws(() => C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 1 }] }, D), e => e.status === 404);
  const b = prod(db, { sku: 'B' });
  assert.throws(() => C.createOrder(db, { customer: '', items: [{ productId: b.id, qty: 1 }] }, D), /Customer/); assert.throws(() => C.createOrder(db, { customer: 'X Y', items: [] }, D), /item/);
  assert.throws(() => C.createOrder(db, { customer: 'X Y', items: [{ productId: b.id, qty: 0 }] }, D), /Quantity/); assert.throws(() => C.createOrder(db, { customer: 'X Y', items: [{ productId: b.id, qty: 1.5 }] }, D), /Quantity/);
});
test('stock count adjustment records the difference with a reason', () => {
  const db = fresh(); const a = prod(db); const p = C.adjust(db, a.id, 17, 'Damaged in storage', D); assert.strictEqual(p.stock, 17);
  assert.strictEqual(db.prepare("SELECT delta FROM movements WHERE reason='adjustment'").get().delta, -3);
  assert.throws(() => C.adjust(db, a.id, 17, 'again', D), /equals/); assert.throws(() => C.adjust(db, a.id, 5, '', D), /why/); assert.throws(() => C.adjust(db, a.id, -1, 'neg', D), /Counted/);
});
test('low stock flag at or below reorder level', () => {
  const db = fresh(); const a = prod(db, { openingStock: 6, reorderLevel: 5 }); assert.strictEqual(C.listProducts(db)[0].low, false);
  C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 1 }] }, D); assert.strictEqual(C.listProducts(db)[0].low, true);
  assert.strictEqual(C.dashboard(db, D).lowCount, 1);
});
test('CSV parser handles quotes, commas, newlines, CRLF', () => {
  assert.deepStrictEqual(C.parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
  assert.throws(() => C.parseCsv('a,"b'), /quote/);
});
test('import: dry run changes nothing; bad rows block everything; good file creates and updates', () => {
  const db = fresh(); prod(db);
  const good = 'sku,name,price,cost,reorder_level,stock\nA-1,Widget v2,12.50,5,3,30\nN-1,"Nail, box",2,1,10,100\n';
  const dry = C.importProducts(db, good, { dryRun: true, day: D }); assert.deepStrictEqual([dry.created, dry.updated, dry.committed], [1, 1, false]); assert.strictEqual(C.listProducts(db).length, 1);
  const bad = 'sku,name,price,stock\nZ-1,Fine,1,5\n??,Bad sku,1,5\nZ-2,Neg,-4,5\nZ-1,Dup,1,1\nZ-3,Frac,1,2.5\n';
  const r = C.importProducts(db, bad, { day: D }); assert.strictEqual(r.committed, false); assert.deepStrictEqual(r.errors.map(e => e.line), [3, 4, 5, 6]); assert.strictEqual(C.listProducts(db).length, 1);
  const ok = C.importProducts(db, good, { day: D }); assert.strictEqual(ok.committed, true);
  const w = C.listProducts(db).find(p => p.sku === 'A-1'); assert.strictEqual(w.name, 'Widget v2'); assert.strictEqual(w.price_cents, 1250); assert.strictEqual(w.stock, 30);
  assert.strictEqual(C.listProducts(db).find(p => p.sku === 'N-1').stock, 100);
  assert.throws(() => C.importProducts(db, 'name,price\nx,1', { day: D }), /Missing column: sku/); assert.throws(() => C.importProducts(db, 'sku,name,price', { day: D }), /header/);
});
test('export neutralises spreadsheet formulas and round-trips through import', () => {
  const db = fresh(); prod(db, { sku: 'F-1', name: '=SUM(A1)', openingStock: 3 });
  const csv = C.productsCsv(db); assert.match(csv, /'=SUM\(A1\)/);
  const db2 = fresh(); assert.strictEqual(C.importProducts(db2, csv, { day: D }).committed, true); assert.strictEqual(C.listProducts(db2)[0].stock, 3);
});
test('dashboard: profit, value, daily series, top products exclude cancelled orders', () => {
  const db = fresh(); seed(db, D); const d = C.dashboard(db, D);
  assert.strictEqual(d.days.length, 14); assert.ok(d.monthRevenue > 0 && d.monthProfit > 0 && d.monthProfit < d.monthRevenue); assert.ok(d.stockValue > 0 && d.retailValue > d.stockValue);
  const a = C.listProducts(db)[0]; const o = C.createOrder(db, { customer: 'X Y', items: [{ productId: a.id, qty: 1 }] }, D); const r1 = C.dashboard(db, D).monthRevenue; C.setOrderStatus(db, o.id, 'cancelled', D);
  assert.strictEqual(C.dashboard(db, D).monthRevenue, r1 - a.price_cents);
});
test('restart persistence on a file database', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), 's.db'); let db = C.open(f); C.createUser(db, 'owner', 'a-long-password'); seed(db, D);
  const before = JSON.stringify([C.listProducts(db).map(p => [p.sku, p.stock]), C.listOrders(db).map(o => [o.number, o.status, o.total])]); db.close();
  db = C.open(f); assert.strictEqual(JSON.stringify([C.listProducts(db).map(p => [p.sku, p.stock]), C.listOrders(db).map(o => [o.number, o.status, o.total])]), before); assert.ok(C.login(db, 'owner', 'a-long-password')); db.close();
});
async function withServer(fn, setup = true) {
  const db = fresh(); seed(db, D); C.createUser(db, 'admin', 'secret-pass-99'); const srv = createApp(db, { today: () => D }); await new Promise(r => srv.listen(0, r));
  try { await fn('http://127.0.0.1:' + srv.address().port, db); } finally { srv.close(); }
}
const ck = async url => (await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret-pass-99' }) })).headers.get('set-cookie').split(';')[0];
test('HTTP: all data endpoints need a session', async () => {
  await withServer(async url => {
    for (const p of ['/api/dashboard', '/api/products', '/api/orders', '/api/export/products.csv', '/api/export/movements.csv', '/api/products/1/movements']) assert.strictEqual((await fetch(url + p)).status, 401, p);
    for (const p of ['/api/products', '/api/orders', '/api/import', '/api/products/1/receive']) assert.strictEqual((await fetch(url + p, { method: 'POST', body: '{}' })).status, 401, p);
  });
});
test('HTTP: order, receive, import, export flow', async () => {
  await withServer(async url => {
    const h = { cookie: await ck(url) }; const post = (p, b) => fetch(url + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
    const prods = (await (await fetch(url + '/api/products', { headers: h })).json()).products; const p = prods[0];
    const o = await post('/api/orders', { customer: 'HTTP Buyer', items: [{ productId: p.id, qty: 1 }] }); assert.strictEqual(o.status, 201);
    assert.strictEqual((await post('/api/orders', { customer: 'HTTP Buyer', items: [{ productId: p.id, qty: 99999 }] })).status, 409);
    assert.strictEqual((await (await post(`/api/products/${p.id}/receive`, { qty: 10 })).json()).product.stock, p.stock - 1 + 10);
    const imp = await (await post('/api/import', { csv: 'sku,name,price\nHTTP-1,Imported,3.5', dryRun: false })).json(); assert.strictEqual(imp.committed, true);
    assert.match(await (await fetch(url + '/api/export/products.csv', { headers: h })).text(), /HTTP-1,Imported,3.50/);
    assert.strictEqual((await post('/api/products', { sku: 'A', name: '' })).status, 400); assert.strictEqual((await fetch(url + '/api/orders', { method: 'POST', headers: h, body: '{bad' })).status, 400);
  });
});
test('HTTP: simultaneous orders for the last units cannot oversell', async () => {
  await withServer(async url => {
    const h = { cookie: await ck(url) }; const p = (await (await fetch(url + '/api/products', { headers: h })).json()).products.find(x => x.stock >= 3 && x.stock <= 12);
    const go = () => fetch(url + '/api/orders', { method: 'POST', headers: h, body: JSON.stringify({ customer: 'Race Test', items: [{ productId: p.id, qty: p.stock }] }) }).then(r => r.status);
    assert.deepStrictEqual((await Promise.all([go(), go(), go()])).sort(), [201, 409, 409]);
    assert.strictEqual((await (await fetch(url + '/api/products', { headers: h })).json()).products.find(x => x.id === p.id).stock, 0);
  });
});
test('HTTP: setup flow, traversal, lockout', async () => {
  const db = C.open(); const srv = createApp(db); await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    assert.strictEqual((await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) })).status, 401);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'short' }) })).status, 400);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'long-enough-pass' }) })).status, 201);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'evil', password: 'long-enough-pass' }) })).status, 409);
    assert.strictEqual((await fetch(url + '/..%2fcore.js')).status, 404);
    let last; for (let i = 0; i < 6; i++) last = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'x' }) }); assert.strictEqual(last.status, 429);
  } finally { srv.close(); }
});

test('reorder report: flags low and fast-moving items, ignores cancelled sales, sensible quantities', () => {
  const db = C.open(); const day = '2026-11-24'; const ago = n => new Date(Date.parse(day + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
  const a = C.saveProduct(db, null, { sku: 'A', name: 'Alpha', price: 5, cost: 2, reorderLevel: 10, openingStock: 8 }, ago(40)); // under level
  const b = C.saveProduct(db, null, { sku: 'B', name: 'Bravo', price: 5, cost: 1, reorderLevel: 2, openingStock: 40 }, ago(40)); // fast seller
  const c = C.saveProduct(db, null, { sku: 'C', name: 'Charlie', price: 5, cost: 1, reorderLevel: 2, openingStock: 40 }, ago(40)); // healthy
  const z = C.saveProduct(db, null, { sku: 'Z', name: 'Zero', price: 5, cost: 3, reorderLevel: 0, openingStock: 0 }, ago(40)); // out of stock but reorder 0
  C.createOrder(db, { customer: 'Cu', items: [{ productId: b.id, qty: 35 }] }, ago(5));
  const gone = C.createOrder(db, { customer: 'Cu', items: [{ productId: c.id, qty: 38 }] }, ago(3)); C.setOrderStatus(db, gone.id, 'cancelled', ago(3));
  const r = C.reorderReport(db, day);
  const by = Object.fromEntries(r.rows.map(x => [x.sku, x]));
  assert.ok(by.A && by.B && by.Z); assert.strictEqual(by.C, undefined); // cancelled sale does not make C look fast
  assert.strictEqual(by.A.reason, 'at or under reorder level'); assert.strictEqual(by.A.suggested, 10 + 0 - 8 || 1);
  assert.strictEqual(by.B.sold30, 35); assert.strictEqual(by.B.cover_days, 4); assert.strictEqual(by.B.suggested, 2 + Math.ceil(35 / 30 * 14) - 5);
  assert.strictEqual(by.Z.reason, 'out of stock'); assert.strictEqual(r.rows[0].sku, 'Z'); // out of stock sorts first
  assert.strictEqual(r.totalCostCents, r.rows.reduce((s, x) => s + x.suggested * { A: 200, B: 100, Z: 300 }[x.sku], 0));
  assert.match(C.reorderCsv(db, day), /^sku,name,in_stock/);
  C.saveProduct(db, z.id, { sku: 'Z', name: 'Zero', price: 5, cost: 3, active: false }, day);
  assert.ok(!C.reorderReport(db, day).rows.some(x => x.sku === 'Z')); // inactive products are not suggested
});
test('product ledger has a running balance that ends at the current stock', () => {
  const db = C.open(); const p = C.saveProduct(db, null, { sku: 'L', name: 'Ledger', price: 1, openingStock: 10 }, '2026-11-01');
  C.receive(db, p.id, 5, 'x', '2026-11-02'); C.createOrder(db, { customer: 'Cu', items: [{ productId: p.id, qty: 3 }] }, '2026-11-03'); C.adjust(db, p.id, 20, 'recount', '2026-11-04');
  const l = C.productLedger(db, p.id);
  assert.deepStrictEqual(l.movements.map(m => m.balance), [20, 12, 15, 10]); assert.strictEqual(l.movements[0].balance, l.product.stock);
  assert.throws(() => C.productLedger(db, 99), e => e.status === 404);
});
