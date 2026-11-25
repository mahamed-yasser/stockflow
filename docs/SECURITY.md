# StockFlow security notes

Status: local demo, **not independently security-reviewed**. Each line below was checked against `core.js` / `server.js` of this repo. Passing tests show the listed behaviours work as written; they are not evidence that the app is secure.

## Implemented
- Passwords: at least 10 characters, stored as a scrypt hash with a random 16-byte salt, compared with `timingSafeEqual` (`createUser`, `login`, `changePassword`).
- Sessions: random 24-byte token stored server-side, 8 hour expiry. Logout deletes the session on the server, so a copied old cookie stops working (tested). Up to 200 expired sessions are deleted on each login. Cookie is `HttpOnly; SameSite=Strict; Path=/`, with `Secure` added when `COOKIE_SECURE=1`. Changing a password deletes the user's other sessions.
- Roles: `owner` and `staff`. Owner-only: audit log, user list and creation, data export. Enforced in `server.js` and covered by `test/roles.test.js`.
- Rate limits (per client IP, in memory): failed logins ( failures per minute, then HTTP 429) and setup requests (10 per minute).
- Audit log: logins, failed logins, password changes and failed attempts (reason only), and every non-GET request with its path and HTTP status. Passwords and field values are not stored.
- Input handling: SQL uses prepared statements with bound values; request bodies are capped (); each core function validates its input and returns a 4xx `AppError`; CSV export prefixes cells starting with `= + - @` to blunt spreadsheet formula injection.
- Headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (`test/headers.test.js`).
- Data export leaves out users, password hashes and sessions.

## Transport (HTTP vs HTTPS)
- By default the server listens on `127.0.0.1` over plain HTTP. That is fine for local use on one machine.
- Setting `HOST` exposes it to a network over plain HTTP, where passwords and session cookies can be read in transit. The app has no TLS of its own. Anything reachable beyond your own machine should sit behind a reverse proxy that terminates HTTPS, with `COOKIE_SECURE=1`.

## Not implemented
- Session list or "sign out everywhere" button (changing the password does sign out other sessions).
- Password reset, two-factor login, account lockout beyond the IP rate limit, removing or demoting users.
- Content-Security-Policy header. No CSRF token (relies on `SameSite=Strict`).
- Rate-limit state is per process and per IP; behind a proxy all clients may share one IP.
- The first visitor to a fresh database becomes the owner.
- No penetration test or third-party review.
