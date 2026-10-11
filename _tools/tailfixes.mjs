import fs from 'fs';
const ed = (f, from, to) => {
  let s = fs.readFileSync(f, 'utf8');
  const pat = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
  const re = new RegExp(pat);
  if (!re.test(s)) { console.log('MISS', f, JSON.stringify(from).slice(0, 80)); return; }
  fs.writeFileSync(f, s.replace(re, to.replace(/\n/g, '\r\n')));
  console.log('ok', f);
};

ed('client/src/entities/viewmodel/weaponKit.ts',
  "if (inner.length === seg) {validateRing(inner, 'annulus inner');}\n  else {inner = resampleRing(inner, seg);}",
  "const bore = inner.length === seg ? inner : resampleRing(inner, seg);\n  if (inner.length === seg) {validateRing(bore, 'annulus inner');}");

ed('client/src/effects/effects.ts',
  "    geo = geo.clone();\n    geo.setAttribute('aAlpha', this.alphaAttr);",
  "    const g = geo.clone();\n    g.setAttribute('aAlpha', this.alphaAttr);");

ed('server_bun/src/moveJudge.ts',
  "    if (vel) {\n      const m = Math.hypot(vel.x, vel.y, vel.z);",
  "    let velClamped = vel;\n    if (vel) {\n      const m = Math.hypot(vel.x, vel.y, vel.z);");

ed('server_bun/src/RoomDeployables.ts',
  "    pos = Object.assign({}, pos, { y: this.groundY(pos)});",
  "    const p2 = Object.assign({}, pos, { y: this.groundY(pos)});");
