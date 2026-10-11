import fs from 'fs';
// node mathsqrt.mjs <warn-file> [--apply] — Math.sqrt(arg) -> (arg) ** 0.5
const apply = process.argv[3] === '--apply';
const files = [...new Set(
  fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)
    .map(l => l.match(/^(.+):(\d+):$/)?.[1] ?? l.match(/^(.+):\d+:\d+:?$/)[1]).filter(Boolean),
)];

function matchParen(s, open) {
  let depth = 0, q = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') { if (--depth === 0) return i; }
  }
  return -1;
}

let n = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let out = '', idx = 0, m;
  const re = /Math\.sqrt\(/g;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) { console.log('UNMATCHED', f, m.index); continue; }
    const arg = src.slice(open + 1, close);
    out += src.slice(idx, m.index) + `(${arg}) ** 0.5`;
    idx = close + 1; n++;
  }
  out += src.slice(idx);
  if (apply && out !== src) fs.writeFileSync(f, out);
}
console.log(n, 'sqrt sites', apply ? 'applied' : 'dry-run');
