import fs from 'fs';
import cp from 'child_process';
const out = cp.execSync('npx -y oxlint client/src shared server_bun/src', {encoding:'utf8', stdio:['pipe','pipe','ignore']});
const hits = [...out.matchAll(/(\S+\.ts):(\d+):\d+: warning unicorn\(consistent-function-scoping\): Function `(\w+)`/g)]
  .map(m => ({f: m[1], line: +m[2], name: m[3]}));
for (const h of hits) {
  const lines = fs.readFileSync(h.f, 'utf8').split(/\r\n|\r|\n/);
  // find the decl start: may be `function name(` or `const name =` on the flagged line or above
  let i = h.line - 1;
  while (i > 0 && !new RegExp(`(function ${h.name}\b|const ${h.name} =)`).test(lines[i])) i--;
  // find stmt end: track braces from decl line
  let j = i, depth = 0, started = false;
  for (; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') { depth--; }
    }
    if (started && depth <= 0 && /;?\s*$/.test(lines[j])) { if (depth <= 0) break; }
    if (!started && /;/.test(lines[j])) break;
  }
  console.log(`### ${h.f}:${h.line} ${h.name} [${i + 1}-${j + 1}]`);
  console.log(lines.slice(i, j + 1).join('\n'));
}
