import fs from 'fs';
import path from 'path';

// Read oxlint output, group no-use-before-define warnings per file.
const oxl = fs.readFileSync('_tools/oxl.txt', 'utf8').split(/\r?\n/);
const byFile = new Map();
for (const line of oxl) {
  const m = line.match(/^([a-zA-Z_/.]+\.ts):(\d+):\d+: warning eslint\(no-use-before-define\): '([a-zA-Z_$][\w$]*)' was used before it was defined/);
  if (!m) { continue; }
  const [, f, lno, name] = m;
  if (!byFile.has(f)) { byFile.set(f, []); }
  byFile.get(f).push({ line: Number(lno), name });
}

const moved = [];
for (const [f, warns] of byFile) {
  if (!fs.existsSync(f)) { console.log('no file', f); continue; }
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const crlf = src.includes('\r\n');

  // Index top-level-ish declarations: 'const|let|function|class NAME' at any depth<=1 (col <=4)
  const decls = []; // {name, start, end, isFn, deps:Set}
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/^ {0,4}(?:export\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      // find statement end: for const/let, scan to terminating ';' at paren depth 0
      let end = i;
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        const t = lines[j];
        for (const ch of t) { if (ch === '(' || ch === '{' || ch === '[') depth++; if (ch === ')' || ch === '}' || ch === ']') depth--; }
        end = j;
        if (depth <= 0 && /;\s*$/.test(t)) { break; }
        if (depth <= 0 && /^\s*}\s*$/.test(t)) { break; }
        if (j - i > 400) { break; }
      }
      const text = lines.slice(i, end + 1).join('\n');
      const deps = new Set((text.match(/\b[a-zA-Z_$][\w$]*\b/g) ?? []).filter((w) => w !== m[1]));
      decls.push({ name: m[1], start: i, end, deps });
    }
  }
  const declOf = new Map();
  for (const d of decls) { if (!declOf.has(d.name)) { declOf.set(d.name, d); } }

  const importEnd = (() => { let e = -1; for (let i = 0; i < lines.length; i++) { if (/^import\b/.test(lines[i])) { e = i; } else if (e >= 0 && lines[i].trim() === '') { } else if (e >= 0) { break; } } return e; })();

  // decide moves: process warnings; for each name, try to move its decl above the earliest warned use
  const plan = new Map(); // name -> useLine
  for (const w of warns) { if (!plan.has(w.name) || w.line < plan.get(w.name)) { plan.set(w.name, w.line); } }

  const moves = []; // {name, start, end, insertAt}
  for (const [name, useLine0] of plan) {
    const d = declOf.get(name);
    if (!d) { continue; }
    if (d.start < useLine0 - 1) { continue; } // already before use
    // earliest use line (0-based) = min warned line for this name (approx: also scan earlier textual occurrences)
    let useIdx = useLine0 - 1;
    // find insertion: after importEnd, but also after any top-level decl whose name appears in deps
    let insertAt = importEnd + 1;
    for (const dep of d.deps) {
      const dd = declOf.get(dep);
      if (dd && dd.name !== name && dd.start > insertAt - 1) {
        // dep declared later — if dep itself is below useIdx, we cannot satisfy both; skip unless dep is a function (hoisted)
        if (!/^ {0,4}(?:export\s+)?function/.test(lines[dd.start])) { insertAt = Math.max(insertAt, dd.end + 1); }
      }
    }
    if (insertAt <= useIdx && insertAt <= d.start) {
      moves.push({ name, start: d.start, end: d.end, insertAt });
    }
  }

  if (!moves.length) { console.log('  (no moves)', f, warns.length); continue; }
  // apply bottom-up: sort by start desc so splices don't shift
  moves.sort((a, b) => b.start - a.start);
  for (const mv of moves) {
    const block = lines.splice(mv.start, mv.end - mv.start + 1);
    let at = mv.insertAt;
    if (at > mv.start) { at -= block.length; }
    lines.splice(at, 0, ...block);
    moved.push(`${f}:${mv.name}`);
  }
  const out = lines.join('\n');
  fs.writeFileSync(f, crlf ? out.replace(/\n/g, '\r\n') : out);
  console.log('moved', moves.length, 'in', f);
}
console.log('total moved:', moved.length);
