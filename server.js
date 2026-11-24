'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const C = require('./core');
// Set COOKIE_SECURE=1 when the app is served over HTTPS so the session cookie is only sent over HTTPS.
const SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function createApp(db, { today = () => C.todayOf(db), loginLimit = 5 } = {}) {
  const hits = new Map(); const limited = (ip, b, max) => { const k = b + ip, t = Date.now(); const a = (hits.get(k) || []).filter(x => t - x < 60000); a.push(t); hits.set(k, a); return a.length > max; };
  const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...extra }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const readBody = req => new Promise((ok, bad) => { let s = ''; req.on('data', c => { s += c; if (s.length > 700000) { bad(new C.AppError('Body too large', 413)); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new C.AppError('Invalid JSON')); } }); });
  const cookie = req => (/(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];
  const fails = new Map();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
    try {
      if (p.startsWith('/api/')) {
        const ip = req.socket.remoteAddress;
        if (m === 'GET' && p === '/api/setup-status') return send(res, 200, { needsSetup: C.needsSetup(db) });
        if (m === 'POST' && p === '/api/setup') {
          if (limited(ip, 'setup', 10)) throw new C.AppError('Too many requests, wait a minute', 429);
          const b = await readBody(req); if (!C.needsSetup(db)) throw new C.AppError('Setup already done', 409);
          const u = String(b.username || '').trim(); if (!/^[A-Za-z0-9._-]{3,30}$/.test(u)) throw new C.AppError('Username: 3 to 30 letters, numbers or . _ -');
          try { C.createUser(db, u, String(b.password || '')); } catch (e) { throw new C.AppError(e.message); }
          const t = C.login(db, u, String(b.password)); return send(res, 201, { ok: true }, 'application/json', { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${SECURE}` });
        }
        if (m === 'POST' && p === '/api/login') {
          const f = fails.get(ip) || { n: 0, t: 0 }; if (f.n >= loginLimit && Date.now() - f.t < 60000) throw new C.AppError('Too many attempts, wait a minute', 429);
          const b = await readBody(req), t = C.login(db, String(b.username || ''), String(b.password || ''));
          if (!t) { fails.set(ip, { n: f.n + 1, t: Date.now() }); throw new C.AppError('Wrong username or password', 401); }
          fails.delete(ip); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${SECURE}` });
        }
        if (m === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' });
        if (!C.sessionUser(db, cookie(req))) throw new C.AppError('Login required', 401);
        let mm;
        if (m === 'GET' && p === '/api/me') return send(res, 200, { ok: true, today: today(), currency: C.setting(db, 'currency'), timezone: C.setting(db, 'tz') });
        if (m === 'GET' && p === '/api/dashboard') return send(res, 200, C.dashboard(db, today()));
        if (m === 'GET' && p === '/api/products') return send(res, 200, { products: C.listProducts(db) });
        if (m === 'POST' && p === '/api/products') return send(res, 201, { product: C.saveProduct(db, null, await readBody(req), today()) });
        if (m === 'POST' && (mm = /^\/api\/products\/(\d+)$/.exec(p))) return send(res, 200, { product: C.saveProduct(db, +mm[1], await readBody(req), today()) });
        if (m === 'POST' && (mm = /^\/api\/products\/(\d+)\/receive$/.exec(p))) { const b = await readBody(req); return send(res, 200, { product: C.receive(db, +mm[1], b.qty, b.note, today()) }); }
        if (m === 'POST' && (mm = /^\/api\/products\/(\d+)\/adjust$/.exec(p))) { const b = await readBody(req); return send(res, 200, { product: C.adjust(db, +mm[1], b.count, b.note, today()) }); }
        if (m === 'GET' && (mm = /^\/api\/products\/(\d+)\/movements$/.exec(p))) return send(res, 200, C.productLedger(db, +mm[1]));
        if (m === 'GET' && p === '/api/reorder') return send(res, 200, C.reorderReport(db, today()));
        if (m === 'GET' && p === '/api/export/reorder.csv') return send(res, 200, C.reorderCsv(db, today()), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="reorder-list.csv"' });
        if (m === 'GET' && p === '/api/orders') return send(res, 200, { orders: C.listOrders(db) });
        if (m === 'POST' && p === '/api/orders') return send(res, 201, { order: C.createOrder(db, await readBody(req), today()) });
        if (m === 'POST' && (mm = /^\/api\/orders\/(\d+)\/status$/.exec(p))) return send(res, 200, { order: C.setOrderStatus(db, +mm[1], (await readBody(req)).status, today()) });
        if (m === 'POST' && p === '/api/import') { const b = await readBody(req); return send(res, 200, C.importProducts(db, String(b.csv || ''), { dryRun: !!b.dryRun, day: today() })); }
        if (m === 'GET' && p === '/api/export/products.csv') return send(res, 200, C.productsCsv(db), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="products.csv"' });
        if (m === 'GET' && p === '/api/export/movements.csv') return send(res, 200, C.movementsCsv(db), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="stock-movements.csv"' });
        throw new C.AppError('Not found', 404);
      }
      if (m !== 'GET') throw new C.AppError('Not found', 404);
      if (p === '/slip' && !C.sessionUser(db, cookie(req))) { res.writeHead(302, { Location: '/' }); return res.end(); }
      const file = p === '/' ? '/index.html' : p === '/slip' ? '/slip.html' : p;
      const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
      if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) throw new C.AppError('Not found', 404);
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    } catch (e) { if (e instanceof C.AppError) return send(res, e.status, { error: e.message }); console.error(e); return send(res, 500, { error: 'Server error' }); }
  });
}
module.exports = { createApp };
if (require.main === module) {
  const db = C.open(process.env.DB || 'stock.db');
  if (process.env.SEED_DEMO === '1' && !db.prepare('SELECT 1 FROM products').get()) require('./seed').seed(db);
  const host = process.env.HOST || '127.0.0.1', port = +process.env.PORT || 3200;
  createApp(db).listen(port, host, () => { console.log(`StockFlow on http://${host}:${port} (local only unless HOST is set)`); if (C.needsSetup(db)) console.log('No account yet: open the page to create one.'); });
}
