// usage: node tools/demo-build/build.js <app-dir> <name> <label> <repo-url> <empty-check-sql>  (writes <app-dir>/demo)
const fs = require('fs'), path = require('path');
const [app, name, label, repo, emptyCheck] = process.argv.slice(2);
const out = path.join(app, 'demo'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const kit = __dirname;
const modules = {};
for (const f of ['core', 'seed', 'server']) modules[f] = fs.readFileSync(path.join(app, f + '.js'), 'utf8').replace(/if \(require\.main === module\) \{[\s\S]*$/, '');
const cfg = { name, label, repo, base: './', emptyCheck, modules };
fs.writeFileSync(path.join(out, 'demo-config.js'), 'window.DEMO_CONFIG=' + JSON.stringify(cfg) + ';');
for (const f of ['sql-wasm.js', 'sql-wasm.wasm', 'runtime.js']) fs.copyFileSync(path.join(kit, f), path.join(out, f));
const css = `
#demo-banner{background:#fff7d6;color:#3b2f00;border-bottom:1px solid #e6cf7a;padding:8px 14px;font:13px/1.4 system-ui,sans-serif;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
#demo-banner button{font:inherit;padding:3px 10px;border:1px solid #b99a1c;background:#fff;color:#3b2f00;border-radius:6px;cursor:pointer}
#demo-banner a{color:#5a4600}
#out{display:none!important}
@media(max-width:640px){#demo-banner{padding:5px 10px;font-size:12px;gap:8px}#demo-banner .long{display:none}#demo-banner button{padding:2px 8px}
header{padding:4px 14px!important}header nav{flex-wrap:nowrap!important;overflow-x:auto;white-space:nowrap}header nav button{flex:0 0 auto;padding:8px 10px!important}}`;
for (const f of fs.readdirSync(path.join(app, 'public'))) {
  let s = fs.readFileSync(path.join(app, 'public', f));
  if (f.endsWith('.html')) {
    s = s.toString('utf8')
      .replace(/(href|src)="\/(?!\/)/g, '$1="')                 // root-relative -> relative, so it works under any path
      .replace(/href="(slip|print|statement)\?/g, 'href="$1.html?')
      .replace(/(`|')\/(slip|print|statement)\?/g, '$1$2.html?')
      .replace('</head>', '<style>' + css + '</style><script src="sql-wasm.js"></script><script src="demo-config.js"></script><script src="runtime.js"></script></head>');
  }
  fs.writeFileSync(path.join(out, f), s);
}
console.log('built', out);
