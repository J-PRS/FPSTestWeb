// no-param-reassign: `param op= ...` inside a block-bodied function ->
// rename the parameter to `p<Name>` and shadow it with
// `let <name> = p<Name>;` at the top of the body.
// Skips: destructured params, arrow-expression bodies, unresolvable sigs.
import fs from 'fs';

const sites = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const byF = new Map();
for (const l of sites) {
  const m = l.match(/^(.+):(\d+):(\d+)/);
  if (!m) continue;
  const arr = byF.get(m[1]) ?? [];
  arr.push([+m[2], +m[3]]);
  byF.set(m[1], arr);
}

let n = 0;
const pending = new Set();
const doneFns = new Set();

for (const [f, list] of byF) {
  let src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const edits = [];
  for (const [ln] of list) {
    const line = lines[ln - 1];
    const am = line.match(/([A-Za-z_$][\w$]*)\s*(?:\?\?=|\+=|-=|\*=|\/=|%=|=[^=>])/);
    if (!am) { pending.add(`${f}:${ln} name? ${line.trim().slice(0, 60)}`); continue; }
    const name = am[1];
    const key = `${f}:${name}`;
    if (doneFns.has(key + ':' + ln)) continue;

    // Scan up for the signature line containing '(' (function/method head).
    let sigLine = -1;
    for (let i = ln - 1; i >= Math.max(0, ln - 80); i--) {
      const l = lines[i];
      if (/\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\bcatch\b|=>/.test(l) && !/function|constructor|\)\s*[:{]/.test(l)) {
        // control-flow or arrow — keep scanning but remember arrow = abort
        if (/=>/.test(l) && !/\bfunction\b/.test(l)) { break; }
      }
      if (/[({]\s*$|\)\s*[:{]|\)\s*=>\s*\{|\bfunction\b.*\(/.test(l) && l.includes('(')) {
        sigLine = i; break;
      }
      if (/^\s*(const|let|var|return|throw)\b/.test(l)) break; // crossed a statement
    }
    if (sigLine < 0) { pending.add(`${f}:${ln} nosig`); continue; }

    const text = lines.slice(sigLine).join('\n');
    const parenStart = text.indexOf('(');
    if (parenStart < 0) { pending.add(`${f}:${ln} noparen`); continue; }
    let depth = 0, parenEnd = -1;
    for (let i = parenStart; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break; } }
    }
    if (parenEnd < 0) { pending.add(`${f}:${ln} parenend`); continue; }
    const params = text.slice(parenStart + 1, parenEnd);
    if (!new RegExp('(^|[,\\s])' + name + '\\s*([?:,]|$)').test(params)) {
      pending.add(`${f}:${ln} notparam(${name})`);
      continue;
    }
    if (new RegExp('=>\\s*[^\\s{]').test(text.slice(parenEnd + 1, parenEnd + 8))) {
      pending.add(`${f}:${ln} arrowbody`);
      continue;
    }
    // body '{' after ')'
    const after = text.slice(parenEnd + 1);
    const braceRel = after.indexOf('{');
    if (braceRel < 0 || braceRel > 200) { pending.add(`${f}:${ln} nobrace`); continue; }

    const newName = 'p' + name[0].toUpperCase() + name.slice(1);
    const sig = text.slice(0, parenEnd + 1);
    const sigLineAbs = lines.slice(0, sigLine).join('\n').length + (sigLine > 0 ? 1 : 0);
    const sigAbs = src.indexOf(sig, sigLineAbs);
    if (sigAbs < 0) { pending.add(`${f}:${ln} sigabs`); continue; }
    const braceAbs = sigAbs + parenEnd + 1 + braceRel + 1;
    const bodyIndent = lines[sigLine].match(/^\s*/)[0] + '  ';
    edits.push({ sigAbs, sigLen: sig.length, sig, braceAbs, name, newName, insert: `\n${bodyIndent}let ${name} = ${newName};` });
    doneFns.add(key + ':' + ln);
  }
  // group by signature: apply ALL renames into one sigNew per sigAbs
  const bySig = new Map();
  for (const e of edits) {
    const g = bySig.get(e.sigAbs) ?? { sig: e.sig, sigLen: e.sigLen, renames: [] };
    g.renames.push([e.name, e.newName]);
    bySig.set(e.sigAbs, g);
  }
  for (const [pos, g] of [...bySig].sort((a, b) => b[0] - a[0])) {
    let sigNew = g.sig;
    for (const [name, newName] of g.renames) {
      sigNew = sigNew.replace(
        new RegExp('(^|[({,\\s])' + name + '(\\s*[?:)])'),
        '$1' + newName + '$2');
    }
    if (sigNew === g.sig) { pending.add(`${f} renamefail-all`); continue; }
    src = src.slice(0, pos) + sigNew + src.slice(pos + g.sigLen);
  }
  // collect inserts, apply desc
  const ins = edits.map(e => [e.braceAbs, e.insert]).sort((a, b) => b[0] - a[0]);
  for (const [pos, s] of ins) {
    src = src.slice(0, pos) + s + src.slice(pos);
  }
  fs.writeFileSync(f, src);
  n += edits.length;
}
console.log(n + ' shadowed');
for (const p of [...pending].slice(0, 40)) console.log('PEND', p);
