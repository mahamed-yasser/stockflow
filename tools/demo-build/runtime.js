/* Browser-only demo runtime. Runs the app's real core.js, seed.js and server.js request handler
   in the page, with SQLite compiled to WebAssembly (sql.js). No server, no network, no accounts.
   Data lives in this browser's localStorage only. */
(function () {
  'use strict';
  var CFG = window.DEMO_CONFIG, KEY = 'demo-db:' + CFG.name;
  var te = new TextEncoder();
  function hex(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
  function Buf(u8) { this.u8 = u8; }
  Buf.from = function (s, enc) { var o = new Uint8Array(s.length / 2); for (var i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return new Buf(o); };
  Buf.prototype.toString = function () { return hex(this.u8); };
  window.Buffer = window.Buffer || Buf;
  /* Demo-only stand-in for node:crypto. Not a real password hash: the demo has one fixed demo user. */
  function fnv(str) { var h = 2166136261 >>> 0; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  var cryptoShim = {
    randomBytes: function (n) { var u = new Uint8Array(n); crypto.getRandomValues(u); return new Buf(u); },
    scryptSync: function (pw, salt, n) { var u = new Uint8Array(n), h = fnv(salt + '|' + pw); for (var i = 0; i < n; i++) { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; u[i] = h >>> 24; } return new Buf(u); },
    timingSafeEqual: function (a, b) { var x = a.u8, y = b.u8; if (x.length !== y.length) return false; var d = 0; for (var i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }
  };
  var SQL;
  function toParams(a) { return a.map(function (v) { return v === undefined ? null : typeof v === 'boolean' ? +v : v; }); }
  function DatabaseSync() {
    var saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
    this.db = saved ? new SQL.Database(Uint8Array.from(atob(saved), function (c) { return c.charCodeAt(0); })) : new SQL.Database();
    this.fresh = !saved;
  }
  DatabaseSync.prototype.exec = function (sql) { this.db.run(sql); };
  DatabaseSync.prototype.prepare = function (sql) {
    var d = this.db;
    function rows(args) { var s = d.prepare(sql), out = []; try { s.bind(toParams(args)); while (s.step()) out.push(s.getAsObject()); } finally { s.free(); } return out; }
    return {
      all: function () { return rows([].slice.call(arguments)); },
      get: function () { return rows([].slice.call(arguments))[0]; },
      run: function () { d.run(sql, toParams([].slice.call(arguments))); var id = d.exec('SELECT last_insert_rowid()')[0].values[0][0]; return { lastInsertRowid: id, changes: d.getRowsModified() }; }
    };
  };
  DatabaseSync.prototype.save = function () {
    try { var u = this.db.export(), s = ''; for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); localStorage.setItem(KEY, btoa(s)); } catch (e) {}
  };

  /* tiny CommonJS loader over the app's own source files */
  var mods = {}, cache = {}, handler = null, theDb = null;
  function req(from, name) {
    if (name === 'node:sqlite') return { DatabaseSync: DatabaseSync };
    if (name === 'node:crypto') return cryptoShim;
    if (name === 'node:http') return { createServer: function (h) { handler = h; return {}; } };
    if (name === 'node:fs' || name === 'node:path') return {};
    var key = name.replace(/^\.\//, '').replace(/\.js$/, '');
    if (cache[key]) return cache[key].exports;
    var m = { exports: {} }; cache[key] = m;
    new Function('require', 'module', 'exports', '__dirname', 'process', mods[key])(function (n) { return req(key, n); }, m, m.exports, '/', { env: {} });
    return m.exports;
  }
  function fakeReq(method, path, body, cookie) {
    var h = {}, listeners = {};
    return {
      method: method, url: path, headers: { cookie: cookie || '' }, socket: { remoteAddress: 'demo' },
      on: function (ev, f) { listeners[ev] = f; if (ev === 'end') setTimeout(function () { if (listeners.data && body) listeners.data(body); listeners.end(); }, 0); return this; },
      destroy: function () {}
    };
  }
  var cookie = '';
  function call(method, path, body) {
    return new Promise(function (resolve) {
      var status = 200, headers = {};
      var res = {
        writeHead: function (c, h) { status = c; headers = h || {}; },
        end: function (b) {
          var sc = headers['Set-Cookie']; if (sc) { cookie = /^sid=([a-f0-9]+)/.test(sc) ? sc.split(';')[0] : ''; }
          resolve({ status: status, headers: headers, body: b });
        }
      };
      handler(fakeReq(method, path, body, cookie), res);
    });
  }
  var DEMO_USER = 'demo', DEMO_PASS = 'demo-only-not-a-real-password';
  var ready = (async function () {
    SQL = await initSqlJs({ locateFile: function (f) { return CFG.base + f; } });
    mods = CFG.modules;
    var C = req('', './core'), app = req('', './server');
    theDb = C.open(':memory:');
    handler = null; app.createApp(theDb, CFG.appOptions || {});
    if (theDb.fresh || C.needsSetup(theDb)) {
      if (C.needsSetup(theDb)) { C.createUser(theDb, DEMO_USER, DEMO_PASS); }
      var emptyCheck = theDb.prepare(CFG.emptyCheck).get();
      if (!emptyCheck) req('', './seed').seed(theDb);
      theDb.save();
    }
    var r = await call('POST', '/api/login', JSON.stringify({ username: DEMO_USER, password: DEMO_PASS }));
    return C;
  })();
  var realFetch = window.fetch.bind(window);
  window.fetch = async function (u, o) {
    var url = new URL(typeof u === 'string' ? u : u.url, location.href), i = url.pathname.indexOf('/api/');
    if (i < 0) return realFetch(u, o);
    await ready;
    var method = (o && o.method) || 'GET', r = await call(method, url.pathname.slice(i) + url.search, o && o.body);
    if (method !== 'GET') theDb.save();
    var type = (r.headers['Content-Type'] || 'application/json');
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': type, 'Content-Disposition': r.headers['Content-Disposition'] || '' } });
  };
  /* CSV export links are plain <a href="/api/...">: fetch them locally and download as a file */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href*="/api/"]'); if (!a) return;
    e.preventDefault();
    fetch(a.getAttribute('href')).then(function (r) { return r.blob().then(function (b) { var n = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || ''); var l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = n ? n[1] : 'export.csv'; document.body.appendChild(l); l.click(); l.remove(); }); });
  });
  window.DemoRuntime = {
    reset: function () { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); }
  };
  /* banner */
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.createElement('div'); b.id = 'demo-banner';
    b.innerHTML = '<span><b>Demo build</b> with fictional data.<span class="long"> ' + CFG.label + ' Runs in your browser. Nothing is sent anywhere. The real app is a local Node.js server.</span></span> <button type="button" id="demo-reset">Reset demo data</button> <a href="' + CFG.repo + '" target="_blank" rel="noopener">Source code</a>';
    document.body.insertBefore(b, document.body.firstChild);
    document.getElementById('demo-reset').onclick = function () { if (confirm('Reset the demo to its original fictional data?')) window.DemoRuntime.reset(); };
  });
})();
