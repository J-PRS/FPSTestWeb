import fs from 'fs';
import cp from 'child_process';
const out = cp.execSync('npx -y oxlint client/src shared server_bun/src', {encoding:'utf8', stdio:['pipe','pipe','ignore']});
const hits = [...out.matchAll(/(\S+\.ts):(\d+):(\d+): warning unicorn\(consistent-function-scoping\): Function `(\w+)`/g)]
  .map(m => ({f: m[1], line: +m[2], col: +m[3], name: m[4]}));
for (const h of hits) {
  const lines = fs.readFileSync(h.f, 'utf8').split(/\r\n|\r|\n/);
  const declLine = h.line - 1;
  const indent = lines[declLine].match(/^\s*/)[0].length;
  // enclosing fn = nearest line above with SMALLER indent that opens a block
  let encl = -1;
  for (let i = declLine - 1; i >= 0; i--) {
    const l = lines[i];
    const li = l.match(/^\s*/)[0].length;
    if (li < indent && l.trim() !== '' && !l.trim().startsWith('}') && !l.trim().startsWith('//')) { encl = i; break; }
  }
  console.log(`${h.f}|${h.line}|${h.name}|${encl + 1}|${lines[encl]?.trim().slice(0, 80)}`);
}
