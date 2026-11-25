# StockFlow performance (measured, not promised)

Reproduce: `node tools/bench.js 2000 10000` (products, orders). In-memory SQLite, one process, fictional data.

Environment of the run below: Node v22.23.5, Linux sandbox container, shared CPU. Your numbers will differ; run it yourself. Single run, no warm-up control, so treat as order of magnitude.

| Operation (2000 products, ~10,200 orders) | ms per call |
|---|---|
| createOrder, 2 lines | 0.49 |
| listProducts (all 2000) | 7.1 |
| reorderReport | 11.4 |
| dashboard | 28.0 |
| productLedger (one product) | 0.04 |
| login (scrypt, slow on purpose) | 21 |

At 200 products and 1,000 orders the dashboard takes 3.4 ms. Dashboard time grows with data because stock is summed from the movements ledger on each call. It is the slowest read and the first place to optimise (stored running balance or cached aggregate) if data grows far beyond this.

Not measured: concurrent users, an on-disk database, HTTP overhead, browser rendering.
