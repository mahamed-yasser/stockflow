'use strict';
const C = require('./core');
// Fictional demo shop. Only used when SEED_DEMO=1.
function seed(db, day = C.todayOf(db)) {
  const d = n => new Date(Date.parse(day + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
  const items = [['TEA-001', 'Mint tea, 100 g', 4.5, 2.1, 20, 80], ['TEA-002', 'Hibiscus tea, 100 g', 5, 2.4, 20, 35], ['COF-001', 'Ground coffee, 250 g', 9.5, 5, 15, 12], ['COF-002', 'Coffee beans, 1 kg', 28, 17, 8, 9], ['MUG-001', 'Ceramic mug, blue', 7, 3.2, 10, 40], ['MUG-002', 'Travel mug, steel', 16, 8, 6, 5], ['HON-001', 'Wild honey, 500 g', 12, 7, 10, 25], ['NUT-001', 'Roasted almonds, 200 g', 6.5, 3.9, 12, 7]];
  const ids = items.map(([sku, name, price, cost, reorder, open]) => C.saveProduct(db, null, { sku, name, price, cost, reorderLevel: reorder, openingStock: open }, d(20)).id);
  let n = 0; const orders = [[['Demo Customer A', [[0, 6], [4, 2]]], 13], [['Demo Customer B', [[2, 3], [6, 2]]], 11], [['Demo Customer C', [[1, 10]]], 9], [['Demo Customer D', [[3, 2], [5, 1]]], 6], [['Demo Customer E', [[0, 8], [7, 4]]], 3], [['Demo Customer F', [[4, 5], [2, 4]]], 1]];
  for (const [[cust, its], ago] of orders) { const o = C.createOrder(db, { customer: cust, items: its.map(([i, q]) => ({ productId: ids[i], qty: q })) }, d(ago)); if (ago > 2) C.setOrderStatus(db, o.id, 'fulfilled', d(ago)); }
}
module.exports = { seed };
