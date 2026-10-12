import fs from 'fs';
import cp from 'child_process';

let out = '';
try { out = cp.execSync('npx -y oxlint client/src shared server_bun/src', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); }
catch (e) { out = e.stdout; }
const hits = [...out.matchAll(/(\S+\.ts):(\d+):(\d+): warning unicorn\(consistent-function-scoping\): Function `(\w+)`/g)]
  .map(m => ({ f: m[1], name: m[4] }))
  .filter(h => !/loadoutMenu|ctfFlags/.test(h.f));

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.f)) { byFile.set(h.f, []); }
  if (!byFile.get(h.f).includes(h.name)) { byFile.get(h.f).push(h.name); }
}

for (const [f, names] of byFile) {
  let lines = fs.readFileSync(f, 'utf8').split('\n');
  for (const name of [...names].reverse()) {
    const re = new RegExp(`\\b(function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*[=:])`);
    // find all decl lines at indent > 0 (inside a scope)
    const cands = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]) && lines[i].match(/^\s*/)[0].length > 0) { cands.push(i); }
    }
    if (!cands.length) { console.log('NODECL', f, name); continue; }
    const s = cands[0];
    const declIndent = lines[s].match(/^\s*/)[0].length;
    // span end: brace-balance from decl line; statement ends at first line
    // where depth returns to 0 and the line ends with ; or } (fn decl)
    let d = 0; let opened = false; let e = s;
    for (let i = s; i < lines.length; i++) {
      const l = lines[i].replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|\/\/.*$/g, '');
      for (const ch of l) {
        if (ch === '{' || ch === '(' || ch === '[') { d++; opened = true; }
        else if (ch === '}' || ch === ')' || ch === ']') { d--; }
      }
      e = i;
      if (opened && d <= 0) { break; }
      if (!opened && /[;,}]/.test(l)) { break; }
      if (i - s > 80) { break; }
    }
    const block = lines.splice(s, e - s + 1).join('\n')
      .replace(new RegExp(`^ {${declIndent}}`, 'gm'), '');
    // insert after last top-level import
    let ins = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('import ')) { ins = i + 1; }
    }
    // collapse the hole left behind (extra blank line if next line was blank)
    lines.splice(ins, 0, block, '');
    console.log('moved', f, name);
  }
  fs.writeFileSync(f, lines.join('\n'));
}
