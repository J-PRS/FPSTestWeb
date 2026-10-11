import fs from 'fs';
// node destructure.mjs <warn-file> [--apply]
//  const|let X = o.p   ->  const {p: X} = o   ({p} when same name)
//  const|let X = a[N]  ->  const [,,X] = a
//  X = o.p             ->  ({p: X} = o)
//  X = a[N]            ->  ([,,X] = a)
const apply = process.argv[3] === '--apply';
const byFile = {};
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (m) (byFile[m[1]] ??= []).push(+m[2] - 1);
}

const pads = n => ', '.repeat(n);
let nDo = 0, nSkip = 0;
for (const [f, rows] of Object.entries(byFile)) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  let dirty = false;
  for (const row of [...new Set(rows)]) {
    let s = src[row];
    let hit = false;
    // decl member: const x = o.p  (o = ident/member, no call)
    s = s.replace(/\b(const|let|var)\s+([\w$]+)\s*=\s*([\w$]+(?:\.[\w$]+)*)\.(\w+)\s*(?=;|,)/g,
      (w, k, x, o, p) => { hit = true; return `${k} {${x === p ? p : `${p}: ${x}`}} = ${o}`; });
    // decl index: const x = a[N]  (N<=2 -> elision pattern, else {N: x})
    s = s.replace(/\b(const|let|var)\s+([\w$]+)\s*=\s*([\w$]+(?:\.[\w$]+)*)\[(\d+)\]/g,
      (w, k, x, a, n) => { hit = true; return +n <= 2 ? `${k} [${pads(+n)}${x}] = ${a}` : `${k} { ${n}: ${x} } = ${a}`; });
    // assign member: x = o.p  (x may be member; parenthesize statement)
    s = s.replace(/(^|[^=<>!])\b([\w$]+(?:\.[\w$]+)*)\s*=\s*([\w$]+(?:\.[\w$]+)*)\.(\w+)\s*(?=;|,|$)/g,
      (w, pre, x, o, p) => {
        hit = true;
        return `${pre}({${x === p ? p : `${p}: ${x}`}} = ${o})`;
      });
    // assign index: x = a[N]
    s = s.replace(/(^|[^=<>!])\b([\w$]+(?:\.[\w$]+)*)\s*=\s*([\w$]+(?:\.[\w$]+)*)\[(\d+)\]/g,
      (w, pre, x, a, n) => { hit = true; return +n <= 2 ? `${pre}([${pads(+n)}${x}] = ${a})` : `${pre}({ ${n}: ${x} } = ${a})`; });
    if (hit) {
      if (s !== src[row]) { console.log(`${f}:${row + 1}: ${s.trim().slice(0, 100)}`); src[row] = s; dirty = true; nDo++; }
    } else {
      console.log(`MANUAL ${f}:${row + 1}: ${s.trim().slice(0, 100)}`);
      nSkip++;
    }
  }
  if (apply && dirty) fs.writeFileSync(f, src.join('\n'));
}
console.log('---', nDo, 'transformed,', nSkip, 'manual');
