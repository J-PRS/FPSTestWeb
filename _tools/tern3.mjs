import fs from 'fs';
const ed = (f, from, to) => {
  const s = fs.readFileSync(f, 'utf8');
  for (const tf of [from, from.replace(/\n/g, '\r\n'), from.replace(/\n/g, '\r\r\n')]) {
    if (s.includes(tf)) {
      const E = tf.includes('\r\r\n') ? '\r\r\n' : tf.includes('\r\n') ? '\r\n' : '\n';
      fs.writeFileSync(f, s.split(tf).join(to.replace(/\n/g, E)));
      console.log('ok', f);
      return;
    }
  }
  console.log('MISS', f, JSON.stringify(from.slice(0, 50)));
};

ed('server_bun/src/wire.ts',
`const optWeaponType = (v: unknown): { ok: boolean; v?: number } =>
  v === undefined ? { ok: true }
    : Number.isInteger(v) && (v as number) in WEAPONS ? { ok: true, v: v as number }
    : { ok: false };`,
`const optWeaponType = (v: unknown): { ok: boolean; v?: number } => {
  if (v === undefined) {return { ok: true };}
  if (Number.isInteger(v) && (v as number) in WEAPONS) {return { ok: true, v: v as number };}
  return { ok: false };
};`);

ed('shared/botClasses.ts',
`return HEAVY_ONLY_WEAPONS.has(w) ? 'heavy' : MEDIUM_ONLY_WEAPONS.has(w) ? 'medium' : 'light';`,
`if (HEAVY_ONLY_WEAPONS.has(w)) {return 'heavy';}
  if (MEDIUM_ONLY_WEAPONS.has(w)) {return 'medium';}
  return 'light';`);

ed('shared/botGraph.ts',
`const ti = team === 'bravo' ? 1 : team === 'alpha' ? 0 : 2;`,
`let ti = 2;
if (team === 'alpha') {ti = 0;}
else if (team === 'bravo') {ti = 1;}`);

ed('shared/combat.ts',
`return n <= 4 ? 4 : n <= 9 ? 3 : 2;`,
`if (n <= 4) {return 4;}
if (n <= 9) {return 3;}
return 2;`);

ed('client/src/effects/debrisShards.ts',
`const geo = geoType < 0.4 ? new THREE.TetrahedronGeometry(m, 0)
    : geoType < 0.7 ? new THREE.DodecahedronGeometry(m, 0)
    : new THREE.IcosahedronGeometry(m, 0);`,
`let geo;
  if (geoType < 0.4) {geo = new THREE.TetrahedronGeometry(m, 0);}
  else if (geoType < 0.7) {geo = new THREE.DodecahedronGeometry(m, 0);}
  else {geo = new THREE.IcosahedronGeometry(m, 0);}`);

ed('client/src/entities/remoteAnim.ts',
`const state = airborne
      ? (jetting ? 'jet' : 'jump')
      : pickLocomotionAnim(h.model.animationState, speed, h.wireSki);`,
`let state;
    if (airborne) {state = jetting ? 'jet' : 'jump';}
    else {state = pickLocomotionAnim(h.model.animationState, speed, h.wireSki);}`);

ed('client/src/game/bots/index.ts',
`return this.ctf?.flagPos(aim === 'own' ? team : team === 'alpha' ? 'bravo' : 'alpha', false);`,
`let flagTeam = team;
    if (aim !== 'own') {flagTeam = team === 'alpha' ? 'bravo' : 'alpha';}
    return this.ctf?.flagPos(flagTeam, false);`);

ed('client/src/game/combat/lightning.ts',
`const target = firing && damaging ? 1 : firing ? 0.55 : 0;`,
`let target = 0;
  if (firing) {target = damaging ? 1 : 0.55;}`);

ed('client/src/game/combat/lightningTrace.ts',
`let s = denom < -1e-6 ? (b * a - wy) / denom : (a > 0 ? 0 : axisH);`,
`let s;
  if (denom < -1e-6) {s = (b * a - wy) / denom;}
  else {s = a > 0 ? 0 : axisH;}`);

ed('client/src/game/entities.ts',
`b.update(dt, deps.lazyTerrain(), b.netDriven ? f.netTargetPosFor(b)

      : f.classicMode ? deps.lazyPlayer().pos

      : f.aggroFor(b, b.pos, dt, PROFILES.fodder));`,
`let ballTarget;
    if (b.netDriven) {ballTarget = f.netTargetPosFor(b);}
    else if (f.classicMode) {ballTarget = deps.lazyPlayer().pos;}
    else {ballTarget = f.aggroFor(b, b.pos, dt, PROFILES.fodder);}
    b.update(dt, deps.lazyTerrain(), ballTarget);`);

ed('client/src/game/gameLoop.ts',
'const fmtBps = (b: number): string => b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)}MB/s` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB/s` : `${Math.round(b)}B/s`;',
`const fmtBps = (b: number): string => {
  if (b >= 1_048_576) {return \`\${(b / 1_048_576).toFixed(1)}MB/s\`;}
  if (b >= 1024) {return \`\${(b / 1024).toFixed(1)}KB/s\`;}
  return \`\${Math.round(b)}B/s\`;
};`);

ed('client/src/game/species/melee.ts',
`const n = u ? 1 : pos ? 1 : SCARAB_PACK_MIN + Math.floor(Math.random() * (SCARAB_PACK_MAX - SCARAB_PACK_MIN + 1));`,
`const n = u || pos ? 1 : SCARAB_PACK_MIN + Math.floor(Math.random() * (SCARAB_PACK_MAX - SCARAB_PACK_MIN + 1));`);

ed('client/src/game/speciesKit.ts',
`const tier = dSq > this.AI_LOD_FAR_SQ ? this.AI_LOD_FAR_DT : dSq > this.AI_LOD_MID_SQ ? this.AI_LOD_MID_DT : 0;`,
`let tier = 0;
    if (dSq > this.AI_LOD_FAR_SQ) {tier = this.AI_LOD_FAR_DT;}
    else if (dSq > this.AI_LOD_MID_SQ) {tier = this.AI_LOD_MID_DT;}`);

ed('client/src/networking/tiers.ts',
`const dc = lane?.readyState === 'open' ? lane : alt?.readyState === 'open' ? alt : null;`,
`let dc = null;
    if (lane?.readyState === 'open') {dc = lane;}
    else if (alt?.readyState === 'open') {dc = alt;}`);

ed('client/src/projectiles/projStuck.ts',
`const anchor = this.stuckTo ? (this.stuckTo.dead ? null : this.stuckTo.pos)
      : this.stuckPlayerId ? (this.stuckMap?.get(this.stuckPlayerId) ?? null)
      : null;`,
`let anchor = null;
    if (this.stuckTo) {anchor = this.stuckTo.dead ? null : this.stuckTo.pos;}
    else if (this.stuckPlayerId) {anchor = this.stuckMap?.get(this.stuckPlayerId) ?? null;}`);

ed('client/src/ui/hud.ts',
`this.sheepReadout.style.color = shown >= 60 ? '#ff6b6b' : shown >= 30 ? '#ffd166' : '#7ddf7d';`,
`let sheepColor = '#7ddf7d';
    if (shown >= 60) {sheepColor = '#ff6b6b';}
    else if (shown >= 30) {sheepColor = '#ffd166';}
    this.sheepReadout.style.color = sheepColor;`);

ed('client/src/ui/hud/scoreboard.ts',
`const map = mapName ? prettifyMapName(mapName) : (label ? 'Default' : '');`,
`let map = '';
  if (mapName) {map = prettifyMapName(mapName);}
  else if (label) {map = 'Default';}`);

ed('client/src/ui/logPanel.ts',
`return m[1] === 'ERROR' ? LogLevel.ERROR : m[1] === 'WARN' ? LogLevel.WARN
    : m[1] === 'DEBUG' || m[1] === 'LOG' ? LogLevel.DEBUG : LogLevel.INFO;`,
`if (m[1] === 'ERROR') {return LogLevel.ERROR;}
  if (m[1] === 'WARN') {return LogLevel.WARN;}
  if (m[1] === 'DEBUG' || m[1] === 'LOG') {return LogLevel.DEBUG;}
  return LogLevel.INFO;`);

ed('client/src/world/mapStructures.ts',
`const nOut = s.kind === 'kit' ? (KIT_HULLS[s.piece ?? '']?.length ?? 0)
        : s.kind === 'root' ? 2 : 1;`,
`let nOut = 1;
      if (s.kind === 'kit') {nOut = KIT_HULLS[s.piece ?? '']?.length ?? 0;}
      else if (s.kind === 'root') {nOut = 2;}`);

ed('server_bun/src/botRoster.ts',
`const loadout = process.env.FPS_SOAK_RANDLO === '1'
        ? { perk: 'vitality' as const, near: pickOf(RANDLO.near), mid: pickOf(RANDLO.mid), far: pickOf(RANDLO.far), belt: pickOf(RANDLO.belt), side: pickOf(RANDLO.side) }
        : wildcard
          ? rollWildcard(botRand)
          : BOT_LOADOUTS[kitIdx]!;`,
`let loadout;
      if (process.env.FPS_SOAK_RANDLO === '1') {loadout = { perk: 'vitality' as const, near: pickOf(RANDLO.near), mid: pickOf(RANDLO.mid), far: pickOf(RANDLO.far), belt: pickOf(RANDLO.belt), side: pickOf(RANDLO.side) };}
      else {loadout = wildcard ? rollWildcard(botRand) : BOT_LOADOUTS[kitIdx]!;}`);

ed('server_bun/src/serverSenses.ts',
`? d < 160 || botRand() < (d < 260 ? 0.6 : d < 320 ? 0.3 : 0.08)`,
`? d < 160 || botRand() < nuggetChance(d)`);

console.log('done');
