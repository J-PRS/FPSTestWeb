import fs from 'fs';
const lines = fs.readFileSync('_tools/.cm.txt', 'utf8').trim().split(/\r?\n/);
const byF = {};
for (const l of lines) {
  const m = l.match(/^(.+):(\d+):(\d+)/);
  if (!m) continue;
  (byF[m[1]] ??= []).push(+m[2]);
}
let n = 0;
for (const f in byF) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  let joined = src.join('\n');
  for (const ln of byF[f]) {
    const s = src[ln - 1];
    const mm = s.match(/static\s+(?:public |private |protected |override |async )*([\w$]+)\s*[<(]/);
    if (!mm) { console.log('NONAME', f, ln, s.trim().slice(0, 60)); continue; }
    const name = mm[1];
    let cls = null;
    for (let i = ln - 1; i >= 0; i--) {
      const cm = src[i].match(/\bclass\s+([\w$]+)/);
      if (cm) { cls = cm[1]; break; }
    }
    if (!cls) { console.log('NOCLASS', f, ln, name); continue; }
    const re = new RegExp('this\\.' + name + '\\s*\\(', 'g');
    joined = joined.replace(re, cls + '.' + name + '(');
    n++;
  }
  fs.writeFileSync(f, joined);
}
console.log(n, 'methods rewired');
