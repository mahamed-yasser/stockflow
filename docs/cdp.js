// Minimal Chrome DevTools driver for the end-to-end scripts. No packages: uses Node's built-in WebSocket and fetch.
// Needs google-chrome (or set CHROME=/path/to/chrome).
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function launch(width = 1280, height = 900, mobile = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-')), port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let tab; for (let i = 0; i < 60 && !tab; i++) { await sleep(250); try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} }
  if (!tab) throw new Error('Chrome did not start');
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0; const pend = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const [ok, bad] = pend.get(d.id); pend.delete(d.id); d.error ? bad(new Error(d.error.message)) : ok(d.result); } };
  const send = (method, params = {}) => new Promise((ok, bad) => { const i = ++id; pend.set(i, [ok, bad]); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const waitSel = async sel => { for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return; await sleep(150); } throw new Error('Not found: ' + sel); };
  return {
    ev, send,
    goto: async url => { await send('Page.navigate', { url }); await sleep(900); },
    click: async sel => { await waitSel(sel); await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); },
    type: async (sel, text) => { await waitSel(sel); await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`); },
    shot: async (file, full = false) => {
      let clip; if (full) { const m = await send('Page.getLayoutMetrics'); clip = { x: 0, y: 0, width, height: Math.min(Math.ceil(m.cssContentSize.height), 3000), scale: 1 }; }
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) }); fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    close: () => { try { ws.close(); proc.kill(); } catch {} },
  };
}
module.exports = { launch };
