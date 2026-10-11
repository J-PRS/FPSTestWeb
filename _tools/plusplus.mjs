import fs from 'fs';

// node plusplus.mjs <warn-file> [--apply]
// Safe postfix->compound transforms only:
//   1. statement-level `X++;` / `X--;`  -> `X += 1;` / `X -= 1;`
//   2. for-update clause `for (...; ...; X++)` -> `X += 1`
// Everything else (arr[i++], x = i++, f(i++), returns) stays manual.
const apply = process.argv[3] === '--apply';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const byFile = {};
for (const l of lines) {
  const m = l.match(/^(.+):(\d+):(\d+):$/);
  if (m) (byFile[m[1]] ??= []).push({ row: +m[2] - 1 });
}

const STMT = /(^|[;{}]\s*)([A-Za-z_$][\w$.\[\]]*)\s*(\+\+|--);\s*$/;
const FOR_UPD = /(for\s*\([^;]*;[^;]*;\s*)([A-Za-z_$][\w$.\[\]]*)\s*(\+\+|--)\s*(\))/;

let nDo = 0, nManual = 0;
for (const [f, sites] of Object.entries(byFile)) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  let dirty = false;
  const rows = [...new Set(sites.map(x => x.row))].sort((a, b) => b - a);
  for (const row of rows) {
    let s = src[row];
    let hit = false;
    const stmtMatch = s.match(STMT);
    if (stmtMatch) {
      const [, pre, operand, op] = stmtMatch;
      // Guard: `x = i++;` — left context must not end in an operator/keyword
      // that consumes the value. pre is `;`/`{`/`}` or line start here.
      console.log(`${f}:${row + 1}: ${operand}${op}; -> ${operand} ${op === '++' ? '+=' : '-='} 1  [stmt]`);
      s = s.replace(STMT, `$1${operand} ${op === '++' ? '+=' : '-='} 1;`);
      hit = true; nDo++;
    }
    let m2;
    const forRe = /(for\s*\([^;]*;[^;]*;\s*)([A-Za-z_$][\w$.\[\]]*)\s*(\+\+|--)\s*(\))/g;
    while ((m2 = forRe.exec(s))) {
      const [, pre, operand, op] = m2;
      console.log(`${f}:${row + 1}: for-update ${operand}${op} -> ${operand} ${op === '++' ? '+=' : '-='} 1`);
      hit = true; nDo++;
    }
    if (hit) {
      s = s.replace(forRe, (whole, pre, operand, op, close) =>
        `${pre}${operand} ${op === '++' ? '+=' : '-='} 1${close}`);
      src[row] = s;
      dirty = true;
    } else {
      console.log(`MANUAL ${f}:${row + 1}: ${s.trim()}`);
      nManual++;
    }
  }
  if (apply && dirty) fs.writeFileSync(f, src.join('\n'));
}
console.log('---', nDo, 'transformed,', nManual, 'manual');
