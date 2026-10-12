import fs from 'fs';
import cp from 'child_process';

let out = '';
try { out = cp.execSync('npx -y oxlint client/src shared server_bun/src', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); }
catch (e) { out = e.stdout; }
const hits = [...out.matchAll(/(\S+\.ts):(\d+):(\d+): warning unicorn\(consistent-function-scoping\): Function `(\w+)`/g)]
  .map(m => ({ f: m[1], line: +m[2], name: m[4] }))
  .filter(h => !/loadoutMenu|ctfFlags/.test(h.f));

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.f)) { byFile.set(h.f, []); }
  byFile.get(h.f).push(h);
}

// find decl span: line containing `function name` or `const|let name` near flagLine
function findSpan(lines, flagLine, name) {
  const re = new RegExp(`(\\bfunction\\s+${name}\\b|\\b(?:const|let)\\s+${name}\\b)`);
  let s = -1;
  for (let i = flagLine; i >= Math.max(0, flagLine - 6); i--) {
    if (re.test(lines[i])) { s = i; break; }
  }
  if (s < 0) {
    for (let i = flagLine + 1; i < Math.min(lines.length, flagLine + 6); i++) {
      if (re.test(lines[i])) { s = i; break; }
    }
  }
  if (s < 0) { return null; }
  // end: balance (), {}, [] — statement ends when depth hits 0 on a line whose
  // stripped tail ends with ';' or '}' (fn decl) after having opened
  let d = 0; let opened = false; let e = s;
  for (let i = s; i < lines.length; i++) {
    const l = lines[i].replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|\/\/.*$/g, '');
    for (const ch of l) {
      if (ch === '{' || ch === '(' || ch === '[') { d++; opened = true; }
      if (ch === '}' || ch === ')' || ch === ']') { d--; }
    }
    e = i;
    if (opened && d <= 0) { break; }
    if (!opened && /;/.test(l)) { break; }
    if (i - s > 60) { break; }
  }
  return { s, e };
}

function importInsert(lines) {
  // after last import line / leading comment block
  let ins = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('import ') || t.startsWith('import{') || t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t === '{' || t === '}' || t.startsWith('from ')) {
      if (t.startsWith('import')) { ins = i + 1; }
      continue;
    }
    break;
  }
  // walk multi-line imports (import {\n...\n} from)
  let j = ins - 1;
  while (j >= 0 && !/from\s+['"]|;\s*$/.test(lines[j])) { j--; ins = j; }
  return ins;
}

for (const [f, list] of byFile) {
  let lines = fs.readFileSync(f, 'utf8').split('\n');
  const inserts = [];
  // dedupe module-scope names
  const seen = new Set();
  for (const h of [...list].sort((a, b) => b.line - a.line)) {
    const flagLine = h.line - 1;
    const span = findSpan(lines, flagLine, h.name);
    if (!span) { console.log('NODECL', f, h.name, h.line); continue; }
    const declIndent = lines[span.s].match(/^\s*/)[0].length;
    let block = lines.splice(span.s, span.e - span.s + 1).join('\n');
    block = block.replace(new RegExp(`^ {${declIndent}}`, 'gm'), '');
    let name = h.name;
    if (seen.has(name)) {
      const nu = name + '2';
      block = block.replace(new RegExp(`\\b${name}\\b`, 'g'), nu);
      // fix call sites of THIS function — they were inside the same enclosing scope;
      // simplest safe fix: rename all `name(` call sites in the file that followed the decl
      // (these inner helpers are file-local single-use)
      const callRe = new RegExp(`\\b${name}\\(`, 'g');
      lines = lines.map((l) => l.replace(callRe, `${nu}(`));
      name = nu;
    }
    seen.add(name);
    // skip if same name already exists at module scope
    const modRe = new RegExp(`^(?:export\\s+)?(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\b)`, 'm');
    if (lines.some((l, i) => modRe.test(l) && (l.match(/^\s*/)[0].length === 0))) {
      const nu = name + 'M';
      block = block.replace(new RegExp(`\\b${name}\\b`, 'g'), nu);
      lines = lines.map((l) => l.replace(new RegExp(`\\b${name}\\(`, 'g'), `${nu}(`));
    }
    inserts.push(block);
  }
  if (inserts.length) {
    const ins = importInsert(lines);
    lines.splice(ins, 0, '', ...inserts, '');
    fs.writeFileSync(f, lines.join('\n'));
    console.log('moved', f, inserts.length);
  }
}
