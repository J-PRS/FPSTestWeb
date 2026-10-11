import fs from 'fs';

// node mathtrunc.mjs <warn-file> [--apply]
// `X | 0` / `X << 0` sites:
//   - operands that can overflow int32 (hash mixing, big multipliers,
//     bit shifts) keep `| 0`/`<< 0` — int32 wrap is the point — and get
//     a scoped oxlint-disable comment on the line above.
//   - everything else -> Math.trunc(X).
const apply = process.argv[3] === '--apply';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const byFile = {};
for (const l of lines) {
  const m = l.match(/^(.+):(\d+):(\d+):$/);
  if (m) (byFile[m[1]] ??= []).push({ row: +m[2] - 1 });
}

function grabOperand(s, idx) {
  let i = idx - 1;
  while (i >= 0 && s[i] === ' ') i--;
  const end = i + 1;
  let depthSq = 0, depthPar = 0;
  while (i >= 0) {
    const c = s[i];
    if (c === ']') { depthSq++; i--; continue; }
    if (c === '[') { if (depthSq > 0) { depthSq--; i--; continue; } break; }
    if (c === ')') { depthPar++; i--; continue; }
    if (c === '(') { if (depthPar > 0) { depthPar--; i--; continue; } break; }
    if (depthSq === 0 && depthPar === 0) {
      if (';,{}?:'.includes(c)) break;
      if (c === '=') break; // =, ==, ===, =>, +=, -= ... all bound the operand
      if (c === '&' && s[i - 1] === '&') break;
      if (c === '|' && s[i - 1] === '|') break;
      if (c === 'n' && s.slice(Math.max(0, i - 5), i + 1) === 'return') break;
      if (c === 'e' && s.slice(Math.max(0, i - 3), i + 1) === 'case') break;
    }
    i--;
  }
  const text = s.slice(i + 1, end);
  const operand = text.trim();
  return { start: i + 1 + (text.length - operand.length), operand };
}

// int32 wrap matters: shifts, hex, 7+ digit literals, big multipliers,
// hash-mixing accumulators (h*31+c, LCG seeds).
const WRAP_RE = /(<<|>>|0x|_79_F5|374_761_393|668_265_263|1_274_126_177|\d{7,}|\*\s*31\b|seed|hash|acc\b)/i;
const OP_RE = /\|\s*0(?![\d.])|<<\s*0(?![\d.])/g;

let nTrunc = 0, nKeep = 0, nSkip = 0;
for (const [f, sites] of Object.entries(byFile)) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  const rows = [...new Set(sites.map(x => x.row))];
  const inserted = [];
  let dirty = false;
  for (const row of rows) {
    const s = src[row];
    const edits = [];
    let m;
    OP_RE.lastIndex = 0;
    while ((m = OP_RE.exec(s))) {
      const op = grabOperand(s, m.index);
      if (!op.operand) { console.log('SKIP', f, row + 1, s.trim()); nSkip++; continue; }
      const isShift = s.slice(m.index, m.index + 2) === '<<';
      if (isShift || WRAP_RE.test(op.operand)) {
        nKeep++;
        console.log(`${f}:${row + 1}: KEEP \`${op.operand} ${isShift ? '<<' : '|'} 0\` + disable comment (int32 wrap)`);
        inserted.push(row);
      } else {
        nTrunc++;
        console.log(`${f}:${row + 1}: ${op.operand} | 0  ->  Math.trunc(${op.operand})`);
        edits.push({ start: op.start, end: m.index + m[0].length, rep: `Math.trunc(${op.operand})` });
      }
    }
    if (edits.length) {
      let ns = s;
      for (let k = edits.length - 1; k >= 0; k--) {
        const e = edits[k];
        ns = ns.slice(0, e.start) + e.rep + ns.slice(e.end);
      }
      src[row] = ns;
      dirty = true;
    }
  }
  // wrap-keep sites: insert disable comments above their lines
  if (inserted.length && apply) {
    for (const row of inserted.sort((a, b) => b - a)) {
      const indent = src[row].match(/^\s*/)[0];
      src.splice(row, 0, `${indent}// oxlint-disable-next-line prefer-math-trunc -- int32 wrap is the point`);
    }
    dirty = true;
  }
  if (apply && dirty) fs.writeFileSync(f, src.join('\n'));
}
console.log('---', nTrunc, 'Math.trunc,', nKeep, 'keep-with-disable,', nSkip, 'skips');
