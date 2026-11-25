'use strict';
// Reproducible micro-benchmark. Run: node tools/bench.js [products] [orders]
// In-memory SQLite, one process, fictional data. Numbers depend on the machine; see docs/PERFORMANCE.md.
const C = require('../core');
const P = Number(process.argv[2] || 2000), O = Number(process.argv[3] || 10000);
const db = C.open(':memory:'), day = '2026-01-15';
const time = (label, n, fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(i); const ms = Number(process.hrtime.bigint() - t) / 1e6; console.log(`${label.padEnd(34)} ${(ms / n).toFixed(3).padStart(9)} ms/op  (n=${n})`); };
console.log(`node ${process.version}, products=${P}, orders=${O}`);
const t0 = Date.now();
for (let i = 0; i < P; i++) C.saveProduct(db, null, { sku: 'SKU-' + i, name: 'Product ' + i, price: 5 + (i % 40), cost: 2, reorderLevel: 10, openingStock: 1000 }, day);
for (let i = 0; i < O; i++) { const o = C.createOrder(db, { customer: 'Customer ' + (i % 50), items: [{ productId: 1 + (i * 7) % P, qty: 1 }, { productId: 1 + (i * 13) % P, qty: 2 }] }, day); if (i % 3) C.setOrderStatus(db, o.id, 'fulfilled', day); }
console.log(`setup (seed) ${((Date.now() - t0) / 1000).toFixed(1)} s`);
time('createOrder (2 lines)', 200, i => C.createOrder(db, { customer: 'Bench', items: [{ productId: 1 + i % P, qty: 1 }, { productId: 1 + (i + 1) % P, qty: 1 }] }, day));
time('listProducts (all)', 20, () => C.listProducts(db));
time('dashboard', 20, () => C.dashboard(db, day));
time('reorderReport', 20, () => C.reorderReport(db, day));
time('productLedger', 200, i => C.productLedger(db, 1 + i % P));
C.createUser(db, 'bench', 'correct-horse-battery');
time('login (scrypt, intended slow)', 5, () => C.login(db, 'bench', 'correct-horse-battery'));
