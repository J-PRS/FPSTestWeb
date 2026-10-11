import fs from 'fs';
// node importfirst.mjs <warn-file> [--apply]
// Moves flagged `import` lines to just before the first non-import,
// non-comment, non-blank statement. Multi-line imports consumed to `;`.
// Bare side-effect imports are reported, not moved (eval-order change).
const apply = process.argv[3] === '--apply';
const byFile = {};
for (const l of fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)) {
  const m = l.match(/^(.+):(\d+):(\d+):?$/);
  if (m) (byFile[m[1]] ??= []).push(+m[2] - 1);
}

const isImport = s => /^\s*import[\s{*'"]/.test(s) && !/^\s*import\(/.test(s);
const isCommentOrBlank = s => /^\s*(\/\/|\/\*|\*|\*\/|$)/.test(s);

let nDo = 0, nSkip = 0;
for (const [f, rows] of Object.entries(byFile)) {
  const src = fs.readFileSync(f, 'utf8').split('\n');
  const del = new Set();
  const moved = [];
  for (const row of [...new Set(rows)].sort((a, b) => a - b)) {
    if (/^\s*import\s+['"]/.test(src[row])) { nSkip++; console.log('SIDE-EFFECT', f, row + 1); continue; }
    if (!isImport(src[row])) { nSkip++; console.log('NOTIMPORT', f, row + 1, src[row].trim().slice(0, 60)); continue; }
    // consume multi-line import until line ends with `;` or contains ` from `
    let block = src[row], end = row;
    while (!/;\s*$/.test(block) && !/ from ['"].*;?\s*$/.test(block) && end + 1 < src.length) {
      end++; block += '\n' + src[end];
      if (end - row > 40) break;
    }
    for (let i = row; i <= end; i++) del.add(i);
    moved.push(block.trim());
    nDo++;
  }
  if (!apply || !del.size) continue;
  // first code statement: skip comments/blanks and whole import
  // STATEMENTS (a multiline `import {` consumes through `;`)
  let firstCode = -1;
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if (isCommentOrBlank(s)) continue;
    if (isImport(s)) {
      while (!/;\s*$/.test(s ? src[i] : '') && !/ from ['"].*;?\s*$/.test(src[i]) && i + 1 < src.length) i++;
      continue;
    }
    firstCode = i;
    break;
  }
  if (firstCode < 0) firstCode = src.length;
  const out = src.filter((_, i) => !del.has(i));
  const delBefore = [...del].filter(d => d < firstCode).length;
  const pos = Math.max(0, firstCode - delBefore);
  out.splice(pos, 0, ...moved);
  fs.writeFileSync(f, out.join('\n'));
}
console.log('---', nDo, 'moved,', nSkip, 'skipped');
