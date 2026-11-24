'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
class AppError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0), cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(cost_cents>=0), reorder_level INTEGER NOT NULL DEFAULT 0 CHECK(reorder_level>=0), active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), delta INTEGER NOT NULL CHECK(delta<>0), reason TEXT NOT NULL CHECK(reason IN('opening','purchase','sale','return','adjustment','import')), ref TEXT, note TEXT, day TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_mv_prod ON movements(product_id);
  CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, customer TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'placed' CHECK(status IN('placed','fulfilled','cancelled')), day TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL CHECK(qty>0), unit_cents INTEGER NOT NULL, cost_cents INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const tz = process.env.SHOP_TZ || 'Africa/Cairo', cur = (process.env.CURRENCY || 'USD').toUpperCase();
  new Intl.DateTimeFormat('en', { timeZone: tz }); new Intl.NumberFormat('en', { style: 'currency', currency: cur });
  db.prepare("INSERT OR IGNORE INTO settings VALUES('tz',?)").run(tz); db.prepare("INSERT OR IGNORE INTO settings VALUES('currency',?)").run(cur);
  return db;
}
const setting = (db, k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k).value;
function todayOf(db, now = new Date()) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: setting(db, 'tz'), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; }
const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const cents = v => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v; if (!Number.isFinite(n) || n < 0 || n > 1e8) throw new AppError('Invalid amount'); return Math.round(n * 100); };
const int = (v, lo, hi, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError(msg); return n; };
const validSku = s => /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(s);

const STOCK = '(SELECT coalesce(sum(delta),0) FROM movements m WHERE m.product_id=p.id)';
function listProducts(db) { return db.prepare(`SELECT p.*, ${STOCK} stock FROM products p ORDER BY p.name`).all().map(p => ({ ...p, low: p.active && p.stock <= p.reorder_level })); }
function getProduct(db, id) { return db.prepare(`SELECT p.*, ${STOCK} stock FROM products p WHERE p.id=?`).get(+id); }
const stockOf = (db, id) => db.prepare('SELECT coalesce(sum(delta),0) s FROM movements WHERE product_id=?').get(id).s;
function move(db, productId, delta, reason, ref, note, day) { db.prepare('INSERT INTO movements(product_id,delta,reason,ref,note,day) VALUES(?,?,?,?,?,?)').run(productId, delta, reason, ref || null, note || null, day); }

function parseProduct(v) {
  const sku = str(v.sku, 30), name = str(v.name, 100);
  if (!validSku(sku)) throw new AppError('SKU: 1 to 30 letters, numbers or . _ - ');
  if (name.length < 2) throw new AppError('Product name is required');
  const price = cents(v.price), cost = cents(v.cost ?? 0), reorder = int(v.reorderLevel ?? 0, 0, 100000, 'Reorder level must be a whole number');
  return { sku, name, price, cost, reorder };
}
function saveProduct(db, id, v, day) {
  const p = parseProduct(v);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (id) {
      if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(+id)) throw new AppError('Product not found', 404);
      if (db.prepare('SELECT 1 FROM products WHERE sku=? COLLATE NOCASE AND id<>?').get(p.sku, +id)) throw new AppError('That SKU is already used', 409);
      db.prepare('UPDATE products SET sku=?,name=?,price_cents=?,cost_cents=?,reorder_level=?,active=? WHERE id=?').run(p.sku, p.name, p.price, p.cost, p.reorder, v.active === false || v.active === 0 ? 0 : 1, +id);
    } else {
      if (db.prepare('SELECT 1 FROM products WHERE sku=? COLLATE NOCASE').get(p.sku)) throw new AppError('That SKU is already used', 409);
      id = Number(db.prepare('INSERT INTO products(sku,name,price_cents,cost_cents,reorder_level) VALUES(?,?,?,?,?)').run(p.sku, p.name, p.price, p.cost, p.reorder).lastInsertRowid);
      const open = int(v.openingStock ?? 0, 0, 1e7, 'Opening stock must be a whole number'); if (open > 0) move(db, id, open, 'opening', null, null, day);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getProduct(db, id);
}
function receive(db, id, qty, note, day) { // stock in
  const q = int(qty, 1, 1e7, 'Quantity must be a whole number above 0'); if (!getProduct(db, id)) throw new AppError('Product not found', 404);
  move(db, +id, q, 'purchase', null, str(note, 100), day); return getProduct(db, id);
}
function adjust(db, id, newCount, note, day) { // set the counted quantity; records the difference
  const n = int(newCount, 0, 1e7, 'Counted quantity must be a whole number, 0 or more'); const reason = str(note, 100);
  if (reason.length < 3) throw new AppError('Say why you are adjusting (3+ characters)');
  db.exec('BEGIN IMMEDIATE');
  try { const p = getProduct(db, id); if (!p) throw new AppError('Product not found', 404); const d = n - p.stock; if (d === 0) throw new AppError('Counted quantity equals the current stock'); move(db, p.id, d, 'adjustment', null, reason, day); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getProduct(db, id);
}
const orderNumber = db => { const r = db.prepare("SELECT number FROM orders ORDER BY id DESC LIMIT 1").get(); return 'SO-' + String(r ? parseInt(r.number.slice(3), 10) + 1 : 1).padStart(5, '0'); };
function createOrder(db, inp, day) {
  const customer = str(inp.customer, 100); if (customer.length < 2) throw new AppError('Customer name is required');
  if (!Array.isArray(inp.items) || !inp.items.length || inp.items.length > 100) throw new AppError('Add at least one item');
  const want = new Map();
  for (const it of inp.items) { const pid = int(it.productId, 1, 1e12, 'Choose a product'); const q = int(it.qty, 1, 1e6, 'Quantity must be a whole number above 0'); want.set(pid, (want.get(pid) || 0) + q); }
  db.exec('BEGIN IMMEDIATE');
  try {
    const short = [];
    for (const [pid, q] of want) { const p = getProduct(db, pid); if (!p || !p.active) throw new AppError('Unknown or inactive product', 404); if (p.stock < q) short.push(`${p.name}: ${p.stock} in stock, ${q} requested`); }
    if (short.length) throw new AppError('Not enough stock. ' + short.join('; '), 409);
    const number = orderNumber(db); const oid = Number(db.prepare('INSERT INTO orders(number,customer,day) VALUES(?,?,?)').run(number, customer, day).lastInsertRowid);
    for (const [pid, q] of want) { const p = getProduct(db, pid); db.prepare('INSERT INTO order_items(order_id,product_id,qty,unit_cents,cost_cents) VALUES(?,?,?,?,?)').run(oid, pid, q, p.price_cents, p.cost_cents); move(db, pid, -q, 'sale', number, null, day); }
    db.exec('COMMIT'); return getOrder(db, oid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function getOrder(db, id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(+id); if (!o) return null;
  o.items = db.prepare('SELECT oi.*, p.name, p.sku FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=? ORDER BY oi.id').all(o.id);
  o.total = o.items.reduce((s, i) => s + i.qty * i.unit_cents, 0); o.units = o.items.reduce((s, i) => s + i.qty, 0); return o;
}
const listOrders = db => db.prepare('SELECT id FROM orders ORDER BY id DESC').all().map(r => getOrder(db, r.id));
function setOrderStatus(db, id, status, day) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const o = getOrder(db, id); if (!o) throw new AppError('Order not found', 404);
    if (status === 'fulfilled') { if (o.status !== 'placed') throw new AppError('Only placed orders can be fulfilled', 409); db.prepare("UPDATE orders SET status='fulfilled' WHERE id=?").run(o.id); }
    else if (status === 'cancelled') { if (o.status === 'cancelled') throw new AppError('Already cancelled', 409); if (o.status === 'fulfilled') throw new AppError('Fulfilled orders cannot be cancelled', 409); db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(o.id); for (const i of o.items) move(db, i.product_id, i.qty, 'return', o.number, 'Order cancelled', day); }
    else throw new AppError('Bad status');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getOrder(db, id);
}
// ---- CSV ----
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c;
  }
  if (q) throw new AppError('CSV has an unclosed quote');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
// dryRun: validate and report without saving. All-or-nothing: any bad row means nothing is imported.
function importProducts(db, text, { dryRun = false, day }) {
  if (text.length > 500000) throw new AppError('File too large (500 KB max)', 413);
  const rows = parseCsv(text); if (rows.length < 2) throw new AppError('CSV needs a header row and at least one product');
  const head = rows[0].map(h => h.trim().toLowerCase()); const need = ['sku', 'name', 'price'];
  for (const n of need) if (!head.includes(n)) throw new AppError(`Missing column: ${n}. Expected sku, name, price, and optionally cost, reorder_level, stock`);
  const col = n => head.indexOf(n); const errors = [], plan = [], seen = new Set();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2; const get = n => col(n) >= 0 ? (r[col(n)] ?? '').trim() : '';
    try {
      const sku = get('sku'); if (seen.has(sku.toLowerCase())) throw new AppError('Duplicate SKU in file'); seen.add(sku.toLowerCase());
      const p = parseProduct({ sku, name: get('name'), price: get('price'), cost: get('cost') || 0, reorderLevel: get('reorder_level') || 0 });
      const stockTxt = get('stock'); const stock = stockTxt === '' ? null : int(stockTxt, 0, 1e7, 'Stock must be a whole number');
      const ex = db.prepare('SELECT id FROM products WHERE sku=? COLLATE NOCASE').get(p.sku);
      plan.push({ ...p, stock, existingId: ex ? ex.id : null });
    } catch (e) { if (!(e instanceof AppError)) throw e; errors.push({ line, error: e.message }); }
  });
  const summary = { created: plan.filter(p => !p.existingId).length, updated: plan.filter(p => p.existingId).length, errors };
  if (errors.length || dryRun) return { ...summary, committed: false, preview: plan.slice(0, 8).map(p => ({ sku: p.sku, name: p.name, action: p.existingId ? 'update' : 'create', price_cents: p.price, stock: p.stock })) };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of plan) {
      let id = p.existingId;
      if (id) db.prepare('UPDATE products SET name=?,price_cents=?,cost_cents=?,reorder_level=? WHERE id=?').run(p.name, p.price, p.cost, p.reorder, id);
      else id = Number(db.prepare('INSERT INTO products(sku,name,price_cents,cost_cents,reorder_level) VALUES(?,?,?,?,?)').run(p.sku, p.name, p.price, p.cost, p.reorder).lastInsertRowid);
      if (p.stock !== null) { const d = p.stock - stockOf(db, id); if (d !== 0) move(db, id, d, 'import', null, 'CSV import sets count', day); }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ...summary, committed: true, preview: [] };
}
const money = c => (c / 100).toFixed(2);
const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const productsCsv = db => ['sku,name,price,cost,reorder_level,stock', ...listProducts(db).map(p => [p.sku, p.name, money(p.price_cents), money(p.cost_cents), p.reorder_level, p.stock].map(esc).join(','))].join('\n') + '\n';
const movementsCsv = db => ['date,sku,product,change,reason,reference,note', ...db.prepare('SELECT m.day,p.sku,p.name,m.delta,m.reason,m.ref,m.note FROM movements m JOIN products p ON p.id=m.product_id ORDER BY m.id').all().map(r => [r.day, r.sku, r.name, r.delta, r.reason, r.ref, r.note].map(esc).join(','))].join('\n') + '\n';
// ---- reports ----
function dashboard(db, today) {
  const prods = listProducts(db).filter(p => p.active);
  const month = today.slice(0, 7);
  const sales = db.prepare("SELECT coalesce(sum(oi.qty*oi.unit_cents),0) rev, coalesce(sum(oi.qty*oi.cost_cents),0) cost, coalesce(sum(oi.qty),0) units FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status<>'cancelled' AND substr(o.day,1,7)=?").get(month);
  const days = []; for (let k = 13; k >= 0; k--) { const d = new Date(Date.parse(today + 'T00:00:00Z') - k * 864e5).toISOString().slice(0, 10); days.push({ day: d, cents: db.prepare("SELECT coalesce(sum(oi.qty*oi.unit_cents),0) v FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status<>'cancelled' AND o.day=?").get(d).v }); }
  const top = db.prepare("SELECT p.name, sum(oi.qty) units, sum(oi.qty*oi.unit_cents) revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id WHERE o.status<>'cancelled' AND substr(o.day,1,7)=? GROUP BY p.id ORDER BY revenue DESC LIMIT 5").all(month);
  return { currency: setting(db, 'currency'), stockValue: prods.reduce((s, p) => s + Math.max(0, p.stock) * p.cost_cents, 0), retailValue: prods.reduce((s, p) => s + Math.max(0, p.stock) * p.price_cents, 0),
    lowCount: prods.filter(p => p.low).length, low: prods.filter(p => p.low).sort((a, b) => a.stock - b.stock).slice(0, 8).map(p => ({ id: p.id, sku: p.sku, name: p.name, stock: p.stock, reorder: p.reorder_level })),
    monthRevenue: sales.rev, monthProfit: sales.rev - sales.cost, monthUnits: sales.units, openOrders: db.prepare("SELECT count(*) n FROM orders WHERE status='placed'").get().n, days, top };
}
// ---- reorder planning ----
// Looks at units sold in the last 30 days (cancelled orders excluded). A product needs ordering when it is at or under its
// reorder level, or would run out within 7 days at the recent sales pace. Suggested quantity restores the reorder level plus 14 days of sales.
function reorderReport(db, today) {
  const from = new Date(Date.parse(today + 'T00:00:00Z') - 30 * 864e5).toISOString().slice(0, 10);
  const sold = new Map(db.prepare("SELECT oi.product_id id, sum(oi.qty) u FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status<>'cancelled' AND o.day>? AND o.day<=? GROUP BY oi.product_id").all(from, today).map(r => [r.id, r.u]));
  const rows = [];
  for (const p of listProducts(db).filter(p => p.active)) {
    const units = sold.get(p.id) || 0, daily = units / 30, cover = daily > 0 ? p.stock / daily : null;
    const need = p.stock <= p.reorder_level || (cover !== null && cover < 7);
    if (!need) continue;
    const suggested = Math.max(1, p.reorder_level + Math.ceil(daily * 14) - p.stock);
    rows.push({ id: p.id, sku: p.sku, name: p.name, stock: p.stock, reorder_level: p.reorder_level, sold30: units, cover_days: cover === null ? null : Math.floor(cover), suggested, est_cost_cents: suggested * p.cost_cents, reason: p.stock <= 0 ? 'out of stock' : p.stock <= p.reorder_level ? 'at or under reorder level' : 'runs out within 7 days' });
  }
  rows.sort((a, b) => (a.stock <= 0 ? -1 : 0) - (b.stock <= 0 ? -1 : 0) || (a.cover_days ?? 1e9) - (b.cover_days ?? 1e9) || a.name.localeCompare(b.name));
  return { asOf: today, currency: setting(db, 'currency'), rows, totalCostCents: rows.reduce((s, r) => s + r.est_cost_cents, 0) };
}
const reorderCsv = (db, today) => ['sku,name,in_stock,reorder_level,sold_last_30_days,days_of_cover,suggested_order,estimated_cost,reason', ...reorderReport(db, today).rows.map(r => [r.sku, r.name, r.stock, r.reorder_level, r.sold30, r.cover_days ?? '', r.suggested, money(r.est_cost_cents), r.reason].map(esc).join(','))].join('\n') + '\n';
// Full stock ledger for one product with a running balance (oldest first in the result), so every count can be traced.
function productLedger(db, id) {
  const p = getProduct(db, id); if (!p) throw new AppError('Product not found', 404);
  let bal = 0; const rows = db.prepare('SELECT id,day,delta,reason,ref,note FROM movements WHERE product_id=? ORDER BY id').all(p.id).map(m => ({ ...m, balance: (bal += m.delta) }));
  return { product: { id: p.id, sku: p.sku, name: p.name, stock: p.stock }, movements: rows.reverse().slice(0, 200) };
}
// ---- auth ----
function createUser(db, u, pw) { if (typeof pw !== 'string' || pw.length < 10) throw new Error('Password must be at least 10 characters'); const salt = crypto.randomBytes(16).toString('hex'); db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(u, salt, crypto.scryptSync(pw, salt, 32).toString('hex')); }
function login(db, u, pw) { const r = db.prepare('SELECT * FROM users WHERE username=?').get(u); if (!r) return null; if (!crypto.timingSafeEqual(crypto.scryptSync(pw, r.salt, 32), Buffer.from(r.hash, 'hex'))) return null; const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, r.id, Date.now() + 8 * 3600e3); return t; }
const sessionUser = (db, t) => t ? db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(t, Date.now()) || null : null;
const needsSetup = db => !db.prepare('SELECT 1 FROM users').get();
module.exports = { reorderReport, reorderCsv, productLedger, AppError, open, setting, todayOf, listProducts, getProduct, saveProduct, receive, adjust, createOrder, getOrder, listOrders, setOrderStatus, parseCsv, importProducts, productsCsv, movementsCsv, dashboard, createUser, login, sessionUser, needsSetup };
