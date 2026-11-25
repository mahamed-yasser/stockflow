# StockFlow architecture

Small on purpose: no framework, no npm dependencies, Node 22+ with the built-in `node:sqlite`.

## Layout
- `core.js`: all business rules and every SQL statement. Plain functions that take a `db` handle. No HTTP here.
- `server.js`: `createApp(db)` returns a `node:http` server. Routing, sessions, rate limits, role checks, security headers, request size limit, static files from `public/`.
- `seed.js`: fictional demo data, used only when `SEED_DEMO=1`.
- `public/`: plain HTML/CSS/JS front end. `demo/` and `tools/demo-build/`: browser-only build (SQLite in WebAssembly, data in localStorage).
- `test/`: `node:test` suites. `core.test.js` (rules), `account.test.js` and `roles.test.js` (accounts, roles, audit, export), `headers.test.js`.

## Key decisions
- **Stock is a ledger.** There is no stock column. Stock is the sum of `movements.delta` per product, so every change has a reason (`opening`, `purchase`, `sale`, `return`, `adjustment`, `import`), a day and an optional note. Counts can be audited and never silently drift.
- **Overselling is refused in the database transaction.** `createOrder` runs inside `BEGIN IMMEDIATE`, checks stock for every line, and rolls back everything if any line is short.
- **Money is integer cents.** Inputs are validated and rounded once (`cents()`); `CHECK` constraints reject negatives.
- **Order lines snapshot price and cost** (`unit_cents`, `cost_cents`) so later price edits do not rewrite history.
- **Validation at the edge of core.** Each function validates its own input and throws `AppError` with an HTTP status; `server.js` maps it to a response.
- **Accounts.** Owner and staff roles; owner-only routes for creating staff, the audit log and data export/import. See `SECURITY.md`.

## Known trade-offs
- Stock totals use a correlated sum over `movements` (indexed by `product_id`). Fine at the sizes in `PERFORMANCE.md`; a stored running balance would be needed for much larger data.
- A single SQLite file and a single Node process. No horizontal scaling, no restore tool for the JSON export.
