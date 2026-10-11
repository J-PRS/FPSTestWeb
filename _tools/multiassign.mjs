import fs from 'fs';
// node multiassign.mjs <warn-file> [--apply]
// Handles single-line forms only:
//   A = B = ... = expr;              ->  Z = expr; Y = Z; A = Y;
//   const|let|var X = A = ... = expr ->  Z = expr; ...; const X = A;
// Chains spanning lines or embedded in expressions stay manual.
const apply = process.argv[3] === '--apply';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const byFile = {};
for (const l of lines) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (m) (byFile[m[1]] ??= []).push(+m[2] - 1);
}
const LVAL = '[\\w$.\'"\\[\\]+*\\-/()]+';

let nDo = 0, nManual = 0;
for (const [f, rows] of Object.entries(byFile)) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  let dirty = false;
  for (const row of [...new Set(rows)].sort((a, b) => b - a)) {
    const s = src[row];
    if (!s.includes('=')) { nManual++; continue; }
    // strip leading decl
    const dm = s.match(/^(\s*)(?:const|let|var)\s+([\w$]+)\s*=\s*(.+?);\s*(?:\/\/.*)?$/);
    const sm = s.match(/^(\s*)(((?:[\w$.'"\[\]+*/()\-]+)\s*=\s*)+(.+?));\s*(?:\/\/.*)?$/);
    if (sm && !sm[3].match(/[<>=!]=|=>/)) {
      // split chain targets on top-level `=`
      const chain = sm[2];
      const parts = chain.split(/(?<![+\-*/%<>=!&|^?:])=(?![=>])/);
      if (parts.length >= 3 && parts.every(p => p.trim())) {
        const targets = parts.slice(0, -1).map(p => p.trim());
        const expr = parts[parts.length - 1].trim();
        const indent = sm[1];
        const out = [`${targets[targets.length - 1]} = ${expr};`];
        for (let k = targets.length - 2; k >= 0; k--) {
          out.push(`${targets[k]} = ${targets[k + 1]};`);
        }
        console.log(`${f}:${row + 1}: chain -> ${out.join(' ')}`);
        src[row] = out.map(o => indent + o).join('\n');
        dirty = true; nDo++;
        continue;
      }
    }
    if (dm) {
      // const X = A = ... = expr  (chain of >=2 targets after decl)
      const rhs = dm[3];
      const parts = rhs.split(/(?<![+\-*/%<>=!&|^?:])=(?![=>])/);
      if (parts.length >= 3 && parts.every(p => p.trim()) && !rhs.match(/[<>=!]=|=>/)) {
        const targets = [dm[2], ...parts.slice(0, -1).map(p => p.trim())];
        const expr = parts[parts.length - 1].trim();
        const indent = dm[1];
        const out = [`${targets[targets.length - 1]} = ${expr};`];
        for (let k = targets.length - 2; k >= 1; k--) {
          out.push(`${targets[k]} = ${targets[k + 1]};`);
        }
        out.push(`const ${targets[0]} = ${targets[1]};`);
        console.log(`${f}:${row + 1}: decl-chain -> ${out.join(' ')}`);
        src[row] = out.map(o => indent + o).join('\n');
        dirty = true; nDo++;
        continue;
      }
    }
    console.log(`MANUAL ${f}:${row + 1}: ${s.trim()}`);
    nManual++;
  }
  if (apply && dirty) fs.writeFileSync(f, src.join('\n'));
}
console.log('---', nDo, 'transformed,', nManual, 'manual');
