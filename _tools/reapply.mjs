import fs from 'fs';
// .oxlintrc: init-declarations off; no-use-before-define keep classes only
let s = fs.readFileSync('.oxlintrc.json', 'utf8');
s = s.replace('"no-use-before-define": "warn"',
  '"no-use-before-define": ["warn", { "functions": false, "classes": true, "variables": false, "allowNamedExports": false }]');
s = s.replace('"init-declarations": "warn"', '"init-declarations": "off"');
fs.writeFileSync('.oxlintrc.json', s);

// gunlab: boundary-any disable
let g = fs.readFileSync('client/src/gunlab.ts', 'utf8');
if (!g.startsWith('/* oxlint-disable')) {
  g = '/* oxlint-disable typescript/no-explicit-any -- Manifold WASM + window debug handles */\n' + g;
}
fs.writeFileSync('client/src/gunlab.ts', g);

// Logger: rename shadowed error
const lf = 'client/src/core/Logger.ts';
let l = fs.readFileSync(lf, 'utf8');
for (const nl of ['\n', '\r\n', '\r\r\n']) {
  const a = `    } catch (error) {${nl}      lines.push(\`diagnostics threw: \${error}\`);`;
  const b = `    } catch (diagErr) {${nl}      lines.push(\`diagnostics threw: \${diagErr}\`);`;
  if (l.includes(a)) { l = l.replace(a, b); break; }
}
fs.writeFileSync(lf, l);

// feedMode: rename helper param
const ff = 'client/src/feed/feedMode.ts';
let f = fs.readFileSync(ff, 'utf8');
for (const nl of ['\n', '\r\n', '\r\r\n']) {
  const a = `const demoStartAt = (requested: string | null): string | null => {${nl}  if (requested === null) {return null;}${nl}  return requested.endsWith('.demo') ? requested : \`\${requested}.demo\`;`;
  const b = `const demoStartAt = (req: string | null): string | null => {${nl}  if (req === null) {return null;}${nl}  return req.endsWith('.demo') ? req : \`\${req}.demo\`;`;
  if (f.includes(a)) { f = f.replace(a, b); break; }
}
fs.writeFileSync(ff, f);

// tiers: lazy class-use disable
const tf = 'client/src/networking/tiers.ts';
let t = fs.readFileSync(tf, 'utf8');
if (!t.includes('no-use-before-define')) {
  for (const nl of ['\n', '\r\n', '\r\r\n']) {
    const a = `    return new ServerRtcTransport(dc, config, conn, ctrl);`;
    if (t.includes(a)) {
      t = t.replace(a, `    // oxlint-disable-next-line no-use-before-define -- class declared below; only instantiated at call time${nl}${a}`);
      break;
    }
  }
}
fs.writeFileSync(tf, t);

// vfx: two lazy class-use disables
const vf = 'client/src/effects/vfx.ts';
let v = fs.readFileSync(vf, 'utf8');
if (!v.includes('no-use-before-define')) {
  for (const nl of ['\n', '\r\n', '\r\r\n']) {
    const a1 = `        new SizeOverLife(new FnValue((t): number => smin + (smax - smin) * t)),`;
    const a2 = `      new SizeOverLife(new FnValue((t): number => 0.3 + (1 - t) * 1.4)),`;
    if (v.includes(a1)) {
      v = v.replace(a1, `        // oxlint-disable-next-line no-use-before-define -- class declared below; constructed lazily${nl}${a1}`);
      v = v.replace(a2, `      // oxlint-disable-next-line no-use-before-define -- class declared below; constructed lazily${nl}${a2}`);
      break;
    }
  }
}
fs.writeFileSync(vf, v);
console.log('done');
