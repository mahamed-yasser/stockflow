// Real server process + real Chrome + file database + restart in the middle.
const { launch } = require('./cdp.js'); const { spawn, execSync } = require('node:child_process'); const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'); const assert = require('node:assert');
const dbf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfE2E-')), 's.db'); const PORT = 3459, U = `http://127.0.0.1:${PORT}`; const PW = crypto.randomBytes(9).toString('base64url');
const start = () => new Promise(r => { const p = spawn('node', ['--no-warnings', 'server.js'], { env: { ...process.env, DB: dbf, PORT, SEED_DEMO: '1' }, cwd: path.join(__dirname, '..') }); let o = ''; p.stdout.on('data', d => { o += d; if (o.includes('StockFlow on')) r({ p, o }); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = await start(); console.log(srv.o.trim().split('\n')[0]); assert.match(execSync(`ss -ltn | grep ${PORT} || true`).toString(), /127\.0\.0\.1:3459/); console.log('listen: loopback only');
  const D = await launch(1280, 900, false);
  await D.goto(U + '/'); await D.shot('docs/01-first-run-setup.png', false);
  await D.type('#su', 'owner'); await D.type('#sp', PW); await D.click('#sf button'); await sleep(1000); await D.shot('docs/02-dashboard.png', true);
  const api = e => D.ev(`fetch(${JSON.stringify(e)}).then(r=>r.json())`);
  await D.click('#nav button[data-v=prod]'); await D.click('.chips button[data-f=low]'); await D.shot('docs/03-products-low-stock.png', false);
  // order: first try to oversell (must fail with a clear message), then a valid order
  const stockOf = async sku => (await api('/api/products')).products.find(p => p.sku === sku).stock;
  const mugBefore = await stockOf('MUG-002'); console.log('MUG-002 stock before:', mugBefore);
  await D.click('#nav button[data-v=ord]'); await D.click('#no'); await D.type('#oc', 'Walk-in customer');
  await D.ev(`(()=>{const s=document.querySelector('.ps');s.value=[...s.options].find(o=>o.text.startsWith('Travel mug')).value;s.dispatchEvent(new Event('input',{bubbles:true}));const q=document.querySelector('.pq');q.value='99';q.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await D.click('#ok'); await sleep(500); const err = await D.ev(`document.getElementById('dmsg').textContent`); console.log('oversell message:', err); assert.match(err, /Not enough stock/); await D.shot('docs/04-oversell-refused.png', false);
  assert.strictEqual(await stockOf('MUG-002'), mugBefore);
  await D.ev(`(()=>{const q=document.querySelector('.pq');q.value='2';q.dispatchEvent(new Event('input',{bubbles:true}))})()`); await D.click('#ok'); await sleep(900);
  assert.strictEqual(await stockOf('MUG-002'), mugBefore - 2); console.log('MUG-002 after order:', mugBefore - 2);
  await D.shot('docs/05-orders.png', false);
  // receive stock through the dialog
  await D.click('#nav button[data-v=prod]'); await D.ev(`[...document.querySelectorAll('#prod tr')].find(r=>r.textContent.includes('MUG-002')).querySelector('[data-s]').click()`); await sleep(700); await D.type('#rq', '25'); await D.type('#rn', 'Supplier delivery'); await D.shot('docs/06-receive-stock-dialog.png', false);
  await D.click('#rcv'); await sleep(900); assert.strictEqual(await stockOf('MUG-002'), mugBefore - 2 + 25); console.log('MUG-002 after receive:', mugBefore + 23);
  // CSV import: bad file first
  await D.click('#nav button[data-v=imp]');
  await D.type('#csv', 'sku,name,price,stock\nPEN-1,Gel pen,1.5,200\n??,Bad,1,1\nPEN-2,Marker,-2,5\n'); await D.click('#chk'); await sleep(600); await D.shot('docs/07-import-errors.png', false);
  assert.ok(!(await api('/api/products')).products.some(p => p.sku === 'PEN-1'));
  await D.type('#csv', 'sku,name,price,cost,reorder_level,stock\nPEN-1,Gel pen,1.5,0.6,50,200\nHON-001,Wild honey 500 g,12.5,7,10,\n'); await D.click('#chk'); await sleep(600); await D.shot('docs/08-import-preview.png', false);
  await D.click('#go'); await sleep(900); assert.strictEqual(await stockOf('PEN-1'), 200); console.log('imported PEN-1 stock:', 200);
  D.close(); srv.p.kill(); await sleep(800); srv = await start(); console.log('restarted');
  const M = await launch(390, 844, true);
  await M.goto(U + '/'); await M.type('#u', 'owner'); await M.type('#p', PW); await M.click('#lf button'); await sleep(1000);
  const ap = e => M.ev(`fetch(${JSON.stringify(e)}).then(r=>r.json())`);
  const ps = (await ap('/api/products')).products; assert.strictEqual(ps.find(p => p.sku === 'MUG-002').stock, mugBefore + 23); assert.ok(ps.find(p => p.sku === 'PEN-1')); console.log('after restart: products', ps.length, 'MUG-002', ps.find(p => p.sku === 'MUG-002').stock);
  const orders = (await ap('/api/orders')).orders; assert.ok(orders.some(o => o.customer === 'Walk-in customer')); console.log('orders after restart:', orders.length);
  await M.shot('docs/09-mobile-dashboard.png', true);
  await M.click('#nav button[data-v=prod]'); await M.shot('docs/10-mobile-products.png', true);
  await M.click('#nav button[data-v=ord]'); await M.ev(`document.querySelector('#ord tr.click').click()`); await sleep(600); await M.shot('docs/11-mobile-order.png', false);
  // reorder list (desktop-style data on mobile), stock history with running balance, packing slip
  await M.ev('close_()'); await M.click('#nav button[data-v=re]'); await sleep(700);
  const rr = await ap('/api/reorder'); assert.ok(rr.rows.length > 0, 'seed shop has items to reorder'); assert.ok(rr.rows.every(x => x.suggested >= 1));
  const shown = await M.ev(`document.querySelectorAll('#re tbody tr').length`); assert.strictEqual(shown, rr.rows.length); console.log('reorder rows:', shown, 'est total cents:', rr.totalCostCents);
  await M.shot('docs/12-mobile-reorder.png', true);
  const csv = await M.ev(`fetch('/api/export/reorder.csv').then(r=>r.text())`); assert.match(csv, /^sku,name,in_stock/);
  await M.click('#re [data-rc]'); await sleep(600); const led = await M.ev(`document.querySelector('#modal').textContent`); assert.match(led, /Stock history/); assert.match(led, /Balance/); await M.ev(`(()=>{const m=document.querySelector('#modal');m.scrollTop=1e6;const d=m.firstElementChild;if(d)d.scrollTop=1e6})()`); await sleep(200); await M.shot('docs/13-mobile-stock-history.png', false);
  await M.ev(`close_()`);
  const oid = (await ap('/api/orders')).orders[0].id; await M.goto(U + `/slip?id=${oid}`); await sleep(700); const slip = await M.ev(`document.body.innerText`); assert.match(slip, /PACKING SLIP/); console.log('packing slip rendered'); await M.shot('docs/14-mobile-packing-slip.png', true);
  M.close(); srv.p.kill(); console.log('E2E PASS'); process.exit(0);
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
