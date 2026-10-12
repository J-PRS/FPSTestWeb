import fs from 'fs';
for (const [f, name] of [
  ['client/src/effects/explosionLayers.ts', 'layerOpacity'],
  ['client/src/feed/feedMode.ts', 'demoStartAt'],
  ['client/src/game/bots/botCtf.ts', 'flagBurstScale'],
  ['server_bun/src/serverSenses.ts', 'nuggetChance'],
]) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (l.includes(`const ${name} = `)) { starts.push(i); } });
  if (starts.length <= 1) { console.log('single', f, starts.length); continue; }
  // remove from second decl start to its closing '};' line inclusive
  const out = [];
  let skip = false;
  for (let i = 0; i < lines.length; i++) {
    if (!skip && starts.slice(1).includes(i)) { skip = true; continue; }
    if (skip) {
      if (lines[i].trim() === '};') { skip = false; }
      continue;
    }
    out.push(lines[i]);
  }
  fs.writeFileSync(f, out.join('\n'));
  console.log('deduped', f, starts.length);
}
