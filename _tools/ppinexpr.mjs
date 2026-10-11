// In-expression ++/-- cleanup: ++X -> (X += 1), --X -> (X -= 1),
// X++ -> ((X += 1) - 1), X-- -> ((X += 1) + 1). X = identifier path
// (a, a.b, this.a.b, a[i] not handled for postfix — logged for manual).
import fs from 'fs';

const sites = fs.readFileSync('_tools/.pp.txt', 'utf8').trim().split(/\r?\n/);
const byF = new Map();
for (const l of sites) {
  const m = l.match(/^(.+):(\d+):(\d+)/);
  if (!m) continue;
  const arr = byF.get(m[1]) ?? [];
  arr.push([+m[2], +m[3]]);
  byF.set(m[1], arr);
}

const PATH = '(?:this\\.)?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';
const preRe = new RegExp('(\\+\\+|--)(' + PATH + ')', 'g');
const postRe = new RegExp('(' + PATH + ')(\\+\\+|--)', 'g');

let n = 0, skip = 0;
for (const [f, list] of byF) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  for (const [ln, col] of list.sort((a, b) => b[1] - a[1])) {
    const i = ln - 1;
    let s = src[i];
    const seg = s.slice(col - 1);
    let m;
    if ((m = seg.match(new RegExp('^(\\+\\+|--)(' + PATH + ')')))) {
      const rep = `(${m[2]} ${m[1] === '++' ? '+' : '-'}= 1)`;
      s = s.slice(0, col - 1) + seg.replace(m[0], rep);
      n++;
    } else if ((m = seg.match(new RegExp('^(' + PATH + ')(\\+\\+|--)')))) {
      const rep = `((${m[1]} ${m[2] === '++' ? '+' : '-'}= 1) ${m[2] === '++' ? '-' : '+'} 1)`;
      s = s.slice(0, col - 1) + seg.replace(m[0], rep);
      n++;
    } else {
      skip++;
      console.log('SKIP', f, ln, s.trim().slice(0, 70));
      continue;
    }
    src[i] = s;
  }
  fs.writeFileSync(f, src.join('\n'));
}
console.log(`${n} transformed, ${skip} skipped`);
