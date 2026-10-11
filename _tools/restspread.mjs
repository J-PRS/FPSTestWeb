import fs from 'fs';
// node restspread.mjs <warn-file> [--apply]
// `{ ...a, k: v, ...b }` -> `Object.assign({}, a, {k: v}, b)`
// `{ ...a }`             -> `Object.assign({}, a)`
const apply = process.argv[3] === '--apply';
const warnLines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const byFile = {};
for (const l of warnLines) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (m) (byFile[m[1]] ??= []).push({ row: +m[2] - 1, col: +m[3] - 1 });
}

const OPEN = { '{': '}', '[': ']', '(': ')' };
const CLOSE = { '}': 1, ']': 1, ')': 1 };

function splitTopLevel(s) {
  // split on commas at bracket depth 0, respecting quotes/templates
  const parts = [];
  let depth = 0, cur = '', i = 0, quote = null;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; }
      else if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; i++; continue; }
    if (OPEN[c]) depth++;
    else if (CLOSE[c]) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
    i++;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

let nDo = 0, nSkip = 0;
for (const [f, sites] of Object.entries(byFile)) {
  let text = fs.readFileSync(f, 'utf8');
  const lineStart = [];
  { let off = 0; for (const l of text.split('\n')) { lineStart.push(off); off += l.length + 1; } }
  // process bottom-to-top so earlier offsets stay valid
  const sorted = [...sites].sort((a, b) => b.row - a.row || b.col - a.col);
  let dirty = false;
  for (const site of sorted) {
    const dotOff = lineStart[site.row] + site.col;
    // oxlint col points at the `...`; verify
    let d = dotOff;
    while (d < text.length && text[d] === ' ') d++;
    if (!text.startsWith('...', d)) {
      // fallback: search the line region for '...'
      const idx = text.indexOf('...', dotOff);
      if (idx < 0 || idx > lineStart[site.row] + 400) { nSkip++; console.log('NOSITE', f, site.row + 1); continue; }
      d = idx;
    }
    // walk left from d-1 to the opener '{' (depth-aware backwards)
    let i = d - 1, depth = 0, open = -1;
    while (i >= 0) {
      const c = text[i];
      if (c === '}') depth++;
      else if (c === '{') { if (depth === 0) { open = i; break; } depth--; }
      i--;
    }
    if (open < 0) { nSkip++; console.log('NOOPEN', f, site.row + 1); continue; }
    // walk right to matching '}'
    let j = open + 1; depth = 1; let close = -1; let quote = null;
    while (j < text.length) {
      const c = text[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        j++; continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; j++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { close = j; break; } }
      j++;
    }
    if (close < 0) { nSkip++; console.log('NOCLOSE', f, site.row + 1); continue; }
    const inner = text.slice(open + 1, close);
    const segs = splitTopLevel(inner);
    if (!segs.some(s => s.trim().startsWith('...'))) { nSkip++; continue; }
    const parts = [];
    let plain = [];
    for (const s of segs) {
      const t = s.trim();
      if (t.startsWith('...')) {
        if (plain.length) { parts.push('{' + plain.join(',') + '}'); plain = []; }
        parts.push(t.slice(3).trim());
      } else if (t) {
        plain.push(t);
      }
    }
    if (plain.length) parts.push('{' + plain.join(',') + '}');
    if (parts.length === 0 || !parts[0].startsWith('{')) parts.unshift('{}');
    const rep = `Object.assign(${parts.join(', ')})`;
    console.log(`${f}:${site.row + 1}: {${inner.slice(0, 60)}...} -> ${rep.slice(0, 80)}`);
    text = text.slice(0, open) + rep + text.slice(close + 1);
    dirty = true; nDo++;
  }
  if (apply && dirty) fs.writeFileSync(f, text);
}
console.log('---', nDo, 'transformed,', nSkip, 'skipped');
