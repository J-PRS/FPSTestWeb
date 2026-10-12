import fs from 'fs';
import cp from 'child_process';

const out = cp.execSync('npx -y oxlint client/src shared server_bun/src', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
const hits = [...out.matchAll(/(\S+\.ts):(\d+):(\d+): warning unicorn\(consistent-function-scoping\): Function `(\w+)`/g)]
  .map(m => ({ f: m[1], line: +m[2], col: +m[3], name: m[4] }))
  .filter(h => !/loadoutMenu|ctfFlags/.test(h.f));

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.f)) { byFile.set(h.f, []); }
  byFile.get(h.f).push(h);
}

function declSpan(lines, flagLine, name) {
  // decl start: nearest line at/above flagLine containing `function name(` or `const|let name =`
  const re = new RegExp(`\\b(function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*[=:])`);
  let s = flagLine;
  while (s > 0 && !re.test(lines[s])) { s--; }
  if (!re.test(lines[s])) { return null; }
  // span end: balance {} () from decl line; statement ends when depth returns to 0 at a line ending with ; or } or ,
  let depth = 0, started = false, e = s;
  for (let i = s; i < lines.length; i++) {
    const l = lines[i].replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|\/\/.*$/g, '');
    for (const ch of l) {
      if (ch === '{' || ch === '(') { depth++; started = true; }
      if (ch === '}' || ch === ')') { depth--; }
    }
    e = i;
    if (started && depth <= 0 && /[;,}]?\s*$/.test(lines[i])) {
      // arrow body could end with `)` or object `}` then `;` — require the line to end stmt
      if (/[;,}]\s*;?\s*$/.test(l.trimEnd() + (lines[i].trimEnd().endsWith(';') ? ';' : '')) || lines[i].trimEnd().endsWith(';') || lines[i].trimEnd().endsWith('}')) {
        if (lines[i].trimEnd().endsWith(';') || /\}\s*\)?\s*;?\s*$/.test(lines[i])) { break; }
      }
      break;
    }
  }
  return { s, e };
}

for (const [f, list] of byFile) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  // process bottom-up so line numbers stay valid
  list.sort((a, b) => b.line - a.line);
  const moved = [];
  for (const h of list) {
    const flagLine = h.line - 1;
    const span = declSpan(lines, flagLine, h.name);
    if (!span) { console.log('NODECL', f, h.name, h.line); continue; }
    const declIndent = lines[span.s].match(/^\s*/)[0].length;
    // enclosing line: nearest above with smaller indent, non-empty, not '}'
    let encl = -1;
    for (let i = span.s - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.trim() === '' || l.trim().startsWith('}') || l.trim().startsWith('//') || l.trim().startsWith('*')) { continue; }
      if (l.match(/^\s*/)[0].length < declIndent) { encl = i; break; }
    }
    if (encl < 0) { console.log('NOENCL', f, h.name); continue; }
    const block = lines.splice(span.s, span.e - span.s + 1);
    // recompute insertion: encl is above the removed block so its index is unchanged
    const text = block.join('\n').replace(new RegExp(`^ {${declIndent}}`, 'gm'), '');
    lines.splice(encl, 0, text, '');
    moved.push(`${f}:${h.name}`);
  }
  fs.writeFileSync(f, lines.join('\n'));
  console.log('moved', moved.join(', '));
}
