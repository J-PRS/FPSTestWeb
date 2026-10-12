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
  console.log('MISS', f, JSON.stringify(from.slice(0, 55)));
};

ed('client/src/core/Logger.ts',
`a instanceof Error ? (a.stack ?? a.message) :
      typeof a === 'object' ? ((): string => { try { return JSON.stringify(a); } catch { return String(a); } })() :
      String(a);`,
`(() => {
        if (a instanceof Error) {return a.stack ?? a.message;}
        if (typeof a === 'object') {try { return JSON.stringify(a); } catch { return String(a); }}
        return String(a);
      })();`);

ed('client/src/core/sfx/weapons.ts',
`const layerJitter = weaponType === WeaponType.Chaingun ? 0.3
    : weaponType === WeaponType.BoltLauncher ? 0.29
    : 0.1;`,
`let layerJitter = 0.1;
  if (weaponType === WeaponType.Chaingun) {layerJitter = 0.3;}
  else if (weaponType === WeaponType.BoltLauncher) {layerJitter = 0.29;}`);

ed('client/src/effects/debris.ts',
`      return { mesh: null, mat: null, inst: a.inst, slot: a.slot,
        radius: opts.kind === 'brush' ? 0.08 : opts.kind === 'goo' ? 0.06 : Math.max(sw, sh, sd) };`,
`      let kindRadius = Math.max(sw, sh, sd);
      if (opts.kind === 'goo') {kindRadius = 0.06;}
      else if (opts.kind === 'brush') {kindRadius = 0.08;}
      return { mesh: null, mat: null, inst: a.inst, slot: a.slot, radius: kindRadius };`);

ed('client/src/effects/debris.ts',
`      return { mesh: null, mat: null, inst: a.inst, slot: a.slot,
        radius: opts.kind === 'goo' ? 0.06 : opts.kind === 'brush' ? 0.08 : Math.max(sw, sh, sd) };`,
`      let kindRadius = Math.max(sw, sh, sd);
      if (opts.kind === 'goo') {kindRadius = 0.06;}
      else if (opts.kind === 'brush') {kindRadius = 0.08;}
      return { mesh: null, mat: null, inst: a.inst, slot: a.slot, radius: kindRadius };`);

ed('client/src/effects/debris.ts',
`const radius = part ? (geo.boundingSphere?.radius ?? 0.3) * 0.35
      : s.sharedGeo ? (geo.boundingSphere?.radius ?? 0.3) * 0.5
      : Math.max(sw, sh, sd);`,
`let radius = Math.max(sw, sh, sd);
    if (part) {radius = (geo.boundingSphere?.radius ?? 0.3) * 0.35;}
    else if (s.sharedGeo) {radius = (geo.boundingSphere?.radius ?? 0.3) * 0.5;}`);

ed('client/src/effects/debrisShards.ts',
`const geo = geoType < 0.4 ? new THREE.TetrahedronGeometry(m, 0)
    : geoType < 0.7 ? new THREE.DodecahedronGeometry(m, 0)
    : new THREE.IcosahedronGeometry(m, 0);`,
`let geo;
  if (geoType < 0.4) {geo = new THREE.TetrahedronGeometry(m, 0);}
  else if (geoType < 0.7) {geo = new THREE.DodecahedronGeometry(m, 0);}
  else {geo = new THREE.IcosahedronGeometry(m, 0);}`);

ed('client/src/effects/explosionLayers.ts',
`      opacity: l.kind === 'glow' ? 0.9 : l.kind === 'smoke' ? 0.55 : 1,`,
`      opacity: layerOpacity(l.kind),`);

ed('client/src/effects/explosionLayers.ts',
`      opacity: l.kind === 'smoke' ? 0.55 : l.kind === 'glow' ? 0.9 : 1,`,
`      opacity: layerOpacity(l.kind),`);

ed('client/src/effects/explosionLayers.ts',
`import { markProbe } from '../core/fxDiag.js';`,
`import { markProbe } from '../core/fxDiag.js';

const layerOpacity = (kind: string): number => {
  if (kind === 'smoke') {return 0.55;}
  if (kind === 'glow') {return 0.9;}
  return 1;
};`);

ed('client/src/entities/crawlerVisual.ts',
`const eyeS = (c.state === 'wander' ? 0.55 : c.state === 'windup' ? 0.9 : 0.75) * 0.55;`,
`let eyeS = 0.75;
  if (c.state === 'wander') {eyeS = 0.55;}
  else if (c.state === 'windup') {eyeS = 0.9;}
  eyeS *= 0.55;`);

ed('client/src/entities/crawlerVisual.ts',
`const amp = c.airborne ? 0.08 : (c.state === 'wander' ? 0.25 : 0.55);`,
`let amp = c.state === 'wander' ? 0.25 : 0.55;
  if (c.airborne) {amp = 0.08;}`);

ed('client/src/entities/modelFx.ts',
`const e = t < up ? t / up : t < up + hold ? 1 : Math.max(0, 1 - (t - up - hold) / down);`,
`let e = Math.max(0, 1 - (t - up - hold) / down);
  if (t < up) {e = t / up;}
  else if (t < up + hold) {e = 1;}`);

ed('client/src/entities/playerAnim.ts',
`const cap = t.name.endsWith('.quaternion') ? 2 : t.name.endsWith('.scale') ? 1e3 : 1e4;`,
`let cap = 1e4;
  if (t.name.endsWith('.quaternion')) {cap = 2;}
  else if (t.name.endsWith('.scale')) {cap = 1e3;}`);

ed('client/src/entities/playerClips.ts',
`const axis = dir === 'L' ? 'L' : dir === 'R' ? 'R' : 'B';`,
`let axis: keyof typeof spec.walkDirs = 'B';
      if (dir === 'L') {axis = 'L';}
      else if (dir === 'R') {axis = 'R';}`);

ed('client/src/entities/playerClips.ts',
`const set = state === 'run' ? (fwdHemi ? 'Sprint01' : 'Run01') : 'Walk01';`,
`let set = 'Walk01';
    if (state === 'run') {set = fwdHemi ? 'Sprint01' : 'Run01';}`);

ed('client/src/entities/playerClips.ts',
`const set = state === 'run' && fwdHemi ? 'Sprint01' : state === 'run' ? 'Run01' : 'Walk01';`,
`let set = 'Walk01';
    if (state === 'run') {set = fwdHemi ? 'Sprint01' : 'Run01';}`);

ed('client/src/entities/playerClips.ts',
`for (const n of ov === undefined ? [] : Array.isArray(ov) ? ov : [ov]) {out.push({ name: n, dir: false });}`,
`let ovList = [] as { name: string; dir: boolean }[] extends never ? string[] : string[];
    if (ov !== undefined) {ovList = Array.isArray(ov) ? ov : [ov];}
    for (const n of ovList) {out.push({ name: n, dir: false });}`);

ed('client/src/entities/playerUal.ts',
`const TORSO = variant === 'vexa'
      ? /^Base_Human(Pelvis|Spine1|Ribcage|Neck|Head)$/
      : (variant === 'cybersoldier' || variant === 'polyart')
      ? /^(Hips|Spine|Chest|Neck|Head)$/
      : variant === 'mannequin'
      ? /^DEF-(hips|spine001|spine003|neck|head)$/
      : /^(Hips|Abdomen|Torso_1|Neck|Head)$/;`,
`let TORSO = /^(Hips|Abdomen|Torso_1|Neck|Head)$/;
    if (variant === 'vexa') {TORSO = /^Base_Human(Pelvis|Spine1|Ribcage|Neck|Head)$/;}
    else if (variant === 'cybersoldier' || variant === 'polyart') {TORSO = /^(Hips|Spine|Chest|Neck|Head)$/;}
    else if (variant === 'mannequin') {TORSO = /^DEF-(hips|spine001|spine003|neck|head)$/;}`);

ed('client/src/entities/rakkVisual.ts',
`const flapAmp = dive ? 0.12 : r.state === 'climb' ? 1 : 0.55;`,
`let flapAmp = r.state === 'climb' ? 1 : 0.55;
  if (dive) {flapAmp = 0.12;}`);

ed('client/src/entities/rakkVisual.ts',
`const flapRate = dive ? 3 : r.state === 'climb' ? 13 : 6;`,
`let flapRate = r.state === 'climb' ? 13 : 6;
  if (dive) {flapRate = 3;}`);

ed('client/src/entities/remoteAnim.ts',
`const state = airborne
      ? (jetting ? 'jet' : 'jump')
      : pickLocomotionAnim(h.model.animationState, speed, h.wireSki);`,
`let state;
    if (airborne) {state = jetting ? 'jet' : 'jump';}
    else {state = pickLocomotionAnim(h.model.animationState, speed, h.wireSki);}`);

ed('client/src/entities/remoteSnapshots.ts',
`return v < lo ? lo : v > hi ? hi : v;`,
`if (v < lo) {return lo;}
if (v > hi) {return hi;}
return v;`);

ed('client/src/entities/scarabPose.ts',
`const amp = sc.airborne ? 0.06 : (sc.vel.lengthSq() > 4 ? 0.6 : 0.2);`,
`let amp = sc.vel.lengthSq() > 4 ? 0.6 : 0.2;
  if (sc.airborne) {amp = 0.06;}`);

ed('client/src/entities/snakePose.ts',
`return (t < 0.1 ? 0.4 - t * 1.2
       : t < 0.45 ? 0.28 + (t - 0.1) * 0.17
       : t < 0.8 ? 0.34 - (t - 0.45) * 0.55
       :            0.145 - (t - 0.8) * 0.55) * 1.3;`,
`let w;
  if (t < 0.1) {w = 0.4 - t * 1.2;}
  else if (t < 0.45) {w = 0.28 + (t - 0.1) * 0.17;}
  else if (t < 0.8) {w = 0.34 - (t - 0.45) * 0.55;}
  else {w = 0.145 - (t - 0.8) * 0.55;}
  return w * 1.3;`);

ed('client/src/entities/vmEnvelopes.ts',
`const ft = t < PUNCH_IN ? t / PUNCH_IN : t < PUNCH_IN + hold + 0.05 ? 1 : Math.max(0, 1 - (t - PUNCH_IN - hold - 0.05) / 0.12);`,
`let ft = Math.max(0, 1 - (t - PUNCH_IN - hold - 0.05) / 0.12);
    if (t < PUNCH_IN) {ft = t / PUNCH_IN;}
    else if (t < PUNCH_IN + hold + 0.05) {ft = 1;}`);

ed('client/src/feed/feedMode.ts',
`  startAt: requested ? (requested.endsWith('.demo') ? requested : \`\${requested}.demo\`) : null,`,
`  startAt: demoStartAt(requested),`);

ed('client/src/feed/feedMode.ts',
`const coarse = typeof window === 'undefined' ? false`,
`const demoStartAt = (requested: string | null): string | null => {
  if (requested === null) {return null;}
  return requested.endsWith('.demo') ? requested : \`\${requested}.demo\`;
};
const coarse = typeof window === 'undefined' ? false`);

ed('client/src/game/blastForce.ts',
`      const selfDmg = selfHit
        ? (enemyBlast ? 0 : aoeDamage * player.mods.selfDamage)
        : enemyBlast
          ? aoeDamageOf(aoeDamage, dpx, radius, scales)
          // A feet-shot launch pays up to SELF_SPLASH_MAX — same rule
          // the server charges bots, so the disc-jump is a real spend
          // for humans too. The perk still shaves it.
          : Math.min(aoeDamageOf(aoeDamage, dpx, radius, scales) + SELF_SPLASH_MAX * (1 - dpx / radius), SELF_SPLASH_MAX) * player.mods.selfDamage;`,
`      // A feet-shot launch pays up to SELF_SPLASH_MAX — same rule
      // the server charges bots, so the disc-jump is a real spend
      // for humans too. The perk still shaves it.
      let selfDmg;
      if (selfHit) {selfDmg = enemyBlast ? 0 : aoeDamage * player.mods.selfDamage;}
      else if (enemyBlast) {selfDmg = aoeDamageOf(aoeDamage, dpx, radius, scales);}
      else {selfDmg = Math.min(aoeDamageOf(aoeDamage, dpx, radius, scales) + SELF_SPLASH_MAX * (1 - dpx / radius), SELF_SPLASH_MAX) * player.mods.selfDamage;}`);

ed('client/src/game/bots/botCtf.ts',
`          deps.lazyTerrain(), kind === 'captured' ? 2.4 : kind === 'dropped' ? 1 : 1.4,`,
`          deps.lazyTerrain(), flagBurstScale(kind),`);

ed('client/src/game/bots/botCtf.ts',
`const _flagBurst = new THREE.Vector3();`,
`const flagBurstScale = (kind: string): number => {
  if (kind === 'captured') {return 2.4;}
  if (kind === 'dropped') {return 1;}
  return 1.4;
};
const _flagBurst = new THREE.Vector3();`);

ed('client/src/game/bots/index.ts',
`return this.ctf?.flagPos(aim === 'own' ? team : team === 'alpha' ? 'bravo' : 'alpha', false);`,
`let flagTeam = team;
    if (aim !== 'own') {flagTeam = team === 'alpha' ? 'bravo' : 'alpha';}
    return this.ctf?.flagPos(flagTeam, false);`);

ed('client/src/game/combat/impact.ts',
`const targetId = p.hitBall ? p.hitBall.id : (p.hitPlayerId ? 0xFF_FF : 0);`,
`let targetId = 0;
  if (p.hitBall) {targetId = p.hitBall.id;}
  else if (p.hitPlayerId) {targetId = 0xFF_FF;}`);

ed('client/src/game/combat/lightning.ts',
`const target = firing ? (damaging ? 1 : 0.55) : 0;`,
`let target = 0;
  if (firing) {target = damaging ? 1 : 0.55;}`);

ed('client/src/game/combat/lightningTrace.ts',
`let s = denom < -1e-6 ? (b * a - wy) / denom : (a > 0 ? 0 : axisH);`,
`let s;
  if (denom < -1e-6) {s = (b * a - wy) / denom;}
  else {s = a > 0 ? 0 : axisH;}`);

ed('client/src/game/deployables.ts',
`const tint = item.kind === 'drone' ? 0x88_DD_FF : item.kind === 'shield' ? 0x66_CC_FF : 0x55_FF_CC;`,
`let tint = 0x55_FF_CC;
  if (item.kind === 'drone') {tint = 0x88_DD_FF;}
  else if (item.kind === 'shield') {tint = 0x66_CC_FF;}`);

ed('client/src/game/entities.ts',
`b.update(dt, deps.lazyTerrain(), b.netDriven ? f.netTargetPosFor(b)

      : f.classicMode ? deps.lazyPlayer().pos

      : f.aggroFor(b, b.pos, dt, PROFILES.fodder));`,
`let ballTarget;
    if (b.netDriven) {ballTarget = f.netTargetPosFor(b);}
    else if (f.classicMode) {ballTarget = deps.lazyPlayer().pos;}
    else {ballTarget = f.aggroFor(b, b.pos, dt, PROFILES.fodder);}
    b.update(dt, deps.lazyTerrain(), ballTarget);`);

ed('client/src/game/flagRun.ts',
`      t < HOLD || atEnd ? 0xFF_D8_4D : this.tasJet[i] ? 0x40_FF_90 : 0xFF_40_60);`,
`      dotColor);`);

ed('client/src/game/flagRun.ts',
`    const atEnd = t >= flight + HOLD;
    (dot.material as THREE.MeshBasicMaterial).color.setHex(`,
`    const atEnd = t >= flight + HOLD;
    let dotColor = 0xFF_40_60;
    if (t < HOLD || atEnd) {dotColor = 0xFF_D8_4D;}
    else if (this.tasJet[i]) {dotColor = 0x40_FF_90;}
    (dot.material as THREE.MeshBasicMaterial).color.setHex(`);

ed('client/src/game/flagRun.ts',
`const spdTxt = atEnd ? 'CAP' : t < HOLD ? 'GRAB' : \`\${spd.toFixed(0)} m/s\`;`,
`let spdTxt = \`\${spd.toFixed(0)} m/s\`;
    if (atEnd) {spdTxt = 'CAP';}
    else if (t < HOLD) {spdTxt = 'GRAB';}`);

ed('client/src/game/gameLoop.ts',
'const fmtBps = (b: number): string => b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)}MB/s` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB/s` : `${Math.round(b)}B/s`;',
`const fmtBps = (b: number): string => {
  if (b >= 1_048_576) {return \`\${(b / 1_048_576).toFixed(1)}MB/s\`;}
  if (b >= 1024) {return \`\${(b / 1024).toFixed(1)}KB/s\`;}
  return \`\${Math.round(b)}B/s\`;
};`);

ed('client/src/game/net/flags.ts',
`    c.frag.show(c.iAmCarrier ? 'YOU HAVE THE FLAG!' : c.mine ? 'OUR FLAG TAKEN!' : 'ENEMY FLAG TAKEN!');`,
`    let flagMsg = 'ENEMY FLAG TAKEN!';
    if (c.iAmCarrier) {flagMsg = 'YOU HAVE THE FLAG!';}
    else if (c.mine) {flagMsg = 'OUR FLAG TAKEN!';}
    c.frag.show(flagMsg);`);

ed('client/src/game/net/flags.ts',
`    frag.show(scored ? (mine ? 'THEY SCORED!' : 'CAPTURED!') : (mine ? 'FLAG RETURNED' : 'ENEMY FLAG RETURNED'));`,
`    let retMsg;
    if (scored) {retMsg = mine ? 'THEY SCORED!' : 'CAPTURED!';}
    else {retMsg = mine ? 'FLAG RETURNED' : 'ENEMY FLAG RETURNED';}
    frag.show(retMsg);`);

ed('client/src/game/net/match.ts',
`    deps.fragMessages.show(winner === 'draw' ? 'DRAW' : iWon ? 'VICTORY' : \`\${winner} WINS\`);`,
`    let endMsg;
    if (winner === 'draw') {endMsg = 'DRAW';}
    else {endMsg = iWon ? 'VICTORY' : \`\${winner} WINS\`;}
    deps.fragMessages.show(endMsg);`);

ed('client/src/game/net/match.ts',
`    deps.fragMessages.show(winner === 'draw' ? 'DRAW' : iWon ? 'VICTORY' : \`\${winner.toUpperCase()} WINS\`);`,
`    let endMsg;
    if (winner === 'draw') {endMsg = 'DRAW';}
    else {endMsg = iWon ? 'VICTORY' : \`\${winner.toUpperCase()} WINS\`;}
    deps.fragMessages.show(endMsg);`);

ed('client/src/game/net/playerKill.ts',
`    deps.fragMessages.show(shooterId === 'environment'
      ? \`YOU DIED\\n\${player.lastDamageSource || 'claimed by the wasteland'}\`
      : shooterId === targetId
        ? \`YOU DIED\\nfragged yourself\`
        : \`YOU DIED\\nfragged by \${displayName(shooterId, roster)}\`);`,
`    let deathMsg;
    if (shooterId === 'environment') {deathMsg = \`YOU DIED\\n\${player.lastDamageSource || 'claimed by the wasteland'}\`;}
    else if (shooterId === targetId) {deathMsg = 'YOU DIED\\nfragged yourself';}
    else {deathMsg = \`YOU DIED\\nfragged by \${displayName(shooterId, roster)}\`;}
    deps.fragMessages.show(deathMsg);`);

ed('client/src/game/net/projectiles.ts',
`const localProjectile = shotId
      ? (pellet === undefined ? registry.byShotId.get(shotId) : registry.byFanSlot.get(\`\${shotId}#\${pellet}\`))
      : undefined;`,
`let localProjectile;
    if (shotId) {
      localProjectile = pellet === undefined ? registry.byShotId.get(shotId) : registry.byFanSlot.get(\`\${shotId}#\${pellet}\`);
    }`);

ed('client/src/game/netBalls.ts',
`return id === nm?.getLocalPlayerId() ? deps.lazyPlayer().pos
    : (id ? deps.world.remotePlayers.get(id)?.pos ?? null : null);`,
`if (id === nm?.getLocalPlayerId()) {return deps.lazyPlayer().pos;}
  return id ? deps.world.remotePlayers.get(id)?.pos ?? null : null;`);

ed('client/src/game/remoteDeployables.ts',
`const teamColor = team === 'alpha' ? 0x55_AA_FF : team === 'bravo' ? 0xFF_88_55 : 0x99_AA_BB;`,
`let teamColor = 0x99_AA_BB;
  if (team === 'alpha') {teamColor = 0x55_AA_FF;}
  else if (team === 'bravo') {teamColor = 0xFF_88_55;}`);

ed('client/src/game/remoteDeployables.ts',
`const plinthR = kind === 'generator' ? 3.4 : kind === 'baseturret' ? 2.2 : 1.6;`,
`let plinthR = 1.6;
  if (kind === 'generator') {plinthR = 3.4;}
  else if (kind === 'baseturret') {plinthR = 2.2;}`);

ed('client/src/game/species/melee.ts',
`const n = u ? 1 : pos ? 1 : SCARAB_PACK_MIN + Math.floor(Math.random() * (SCARAB_PACK_MAX - SCARAB_PACK_MIN + 1));`,
`const n = u || pos ? 1 : SCARAB_PACK_MIN + Math.floor(Math.random() * (SCARAB_PACK_MAX - SCARAB_PACK_MIN + 1));`);

ed('client/src/game/speciesKit.ts',
`const tier = dSq > this.AI_LOD_FAR_SQ ? this.AI_LOD_FAR_DT : dSq > this.AI_LOD_MID_SQ ? this.AI_LOD_MID_DT : 0;`,
`let tier = 0;
    if (dSq > this.AI_LOD_FAR_SQ) {tier = this.AI_LOD_FAR_DT;}
    else if (dSq > this.AI_LOD_MID_SQ) {tier = this.AI_LOD_MID_DT;}`);

ed('client/src/game/vgs.ts',
`const scopeColor = (s: 'global' | 'team' | 'mixed'): "#fd8" | "#7d7" | "#ccc" =>
  s === 'global' ? '#fd8' : s === 'team' ? '#7d7' : '#ccc';`,
`const scopeColor = (s: 'global' | 'team' | 'mixed'): "#fd8" | "#7d7" | "#ccc" => {
  if (s === 'global') {return '#fd8';}
  if (s === 'team') {return '#7d7';}
  return '#ccc';
};`);

ed('client/src/game/vgs.ts',
`const scopeColor = (s: 'global' | 'team' | 'mixed'): "#fd8" | "#7d7" | "#ccc" => {
  if (s === 'global') {return '#fd8';}
  if (s === 'team') {return '#7d7';}
  return '#ccc';
};`, `const scopeColor = (s: 'global' | 'team' | 'mixed'): "#fd8" | "#7d7" | "#ccc" => {
  if (s === 'global') {return '#fd8';}
  if (s === 'team') {return '#7d7';}
  return '#ccc';
};`);

ed('client/src/gunlab/scans.ts',
`const drop = an.x > an.y ? (an.x > an.z ? 0 : 2) : (an.y > an.z ? 1 : 2);`,
`let drop = 2;
      if (an.x > an.y && an.x > an.z) {drop = 0;}
      else if (an.y > an.z) {drop = 1;}`);

ed('client/src/gunlab/scans.ts',
`const proj = (v: THREE.Vector3): THREE.Vector2 => drop === 0 ? new THREE.Vector2(v.y, v.z) : drop === 1 ? new THREE.Vector2(v.x, v.z) : new THREE.Vector2(v.x, v.y);`,
`const proj = (v: THREE.Vector3): THREE.Vector2 => {
        if (drop === 0) {return new THREE.Vector2(v.y, v.z);}
        if (drop === 1) {return new THREE.Vector2(v.x, v.z);}
        return new THREE.Vector2(v.x, v.y);
      };`);

ed('client/src/lab/scenarios.ts',
`(f.mesh.material as THREE.MeshBasicMaterial).color.setHex(f.flash > 0 ? 0xFF_FF_FF : (f === a ? 0x5A_D0_FF : 0xFF_6A_4D));`,
`let boltColor = f === a ? 0x5A_D0_FF : 0xFF_6A_4D;
        if (f.flash > 0) {boltColor = 0xFF_FF_FF;}
        (f.mesh.material as THREE.MeshBasicMaterial).color.setHex(boltColor);`);

ed('client/src/lab/simKit.ts',
`(beam.material as THREE.LineBasicMaterial).opacity =
        flash > 0 ? 1 : (c.state === 'charge' ? 0.45 : 0);`,
`let beamOpacity = 0;
      if (flash > 0) {beamOpacity = 1;}
      else if (c.state === 'charge') {beamOpacity = 0.45;}
      (beam.material as THREE.LineBasicMaterial).opacity = beamOpacity;`);

ed('client/src/lab/simKit.ts',
`(wall.axis === 'x' ? p.pos.x : wall.axis === 'y' ? p.pos.y : p.pos.z) * Math.sign(wall.at) >= Math.abs(wall.at)`,
`p.pos[wall.axis] * Math.sign(wall.at) >= Math.abs(wall.at)`);

ed('client/src/main.ts',
`const counts = mode === 'flagrun' ? { alpha: want ?? 0, bravo: 0 }
    : want === undefined ? spec.ffa ? { alpha: 5, bravo: 4 } : { alpha: 4, bravo: 5 }
    : { alpha: Math.floor(want / 2), bravo: Math.ceil(want / 2) };`,
`let counts;
  if (mode === 'flagrun') {counts = { alpha: want ?? 0, bravo: 0 };}
  else if (want === undefined) {counts = spec.ffa ? { alpha: 5, bravo: 4 } : { alpha: 4, bravo: 5 };}
  else {counts = { alpha: Math.floor(want / 2), bravo: Math.ceil(want / 2) };}`);

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

ed('client/src/projectiles/sweep.ts',
`t = t < 0 ? 0 : t > 1 ? 1 : t;`,
`if (t < 0) {t = 0;}
  else if (t > 1) {t = 1;}`);

ed('client/src/ui/hud.ts',
`this.sheepReadout.style.color = shown >= 60 ? '#ff6b6b' : shown >= 30 ? '#ffd166' : '#7ddf7d';`,
`let sheepColor = '#7ddf7d';
    if (shown >= 60) {sheepColor = '#ff6b6b';}
    else if (shown >= 30) {sheepColor = '#ffd166';}
    this.sheepReadout.style.color = sheepColor;`);

ed('client/src/ui/hud/hudStats.ts',
`const fpsColor =
      this.fpsValue < 40 ? '#f44' :
      this.fpsValue < 50 ? '#f80' :
      this.fpsValue < 59 ? '#ff4' : '#8cf';`,
`let fpsColor = '#8cf';
    if (this.fpsValue < 40) {fpsColor = '#f44';}
    else if (this.fpsValue < 50) {fpsColor = '#f80';}
    else if (this.fpsValue < 59) {fpsColor = '#ff4';}`);

ed('client/src/ui/hud/scoreboard.ts',
`const map = mapName ? prettifyMapName(mapName) : (label ? 'Default' : '');`,
`let map = '';
  if (mapName) {map = prettifyMapName(mapName);}
  else if (label) {map = 'Default';}`);

ed('client/src/ui/hud/scoreboard.ts',
`r.ping === null ? '—' : typeof r.ping === 'string' ? r.ping : String(Math.round(r.ping))`,
`scoreboardPing(r.ping)`);

ed('client/src/ui/hud/scoreboard.ts',
`const FRAG_RANKED: ReadonlySet<string> = new Set(['dm', 'tdm', 'duel']);`,
`const FRAG_RANKED: ReadonlySet<string> = new Set(['dm', 'tdm', 'duel']);

const scoreboardPing = (ping: number | string | null): string => {
  if (ping == null) {return '—';}
  if (typeof ping === 'string') {return ping;}
  return String(Math.round(ping));
};`);

ed('client/src/ui/logPanel.ts',
`return m[1] === 'ERROR' ? LogLevel.ERROR : m[1] === 'WARN' ? LogLevel.WARN
    : m[1] === 'DEBUG' || m[1] === 'LOG' ? LogLevel.DEBUG : LogLevel.INFO;`,
`if (m[1] === 'ERROR') {return LogLevel.ERROR;}
  if (m[1] === 'WARN') {return LogLevel.WARN;}
  if (m[1] === 'DEBUG' || m[1] === 'LOG') {return LogLevel.DEBUG;}
  return LogLevel.INFO;`);

ed('client/src/weapons.ts',
`  return {
    weaponType, rate, config, kick,
    kind: opts.pellets ? 'fan'
      : weaponType === WeaponType.Lightning || weaponType === WeaponType.Repair ? 'beam' : 'projectile',`,
`  let kind: WeaponDef['kind'] = 'projectile';
  if (opts.pellets) {kind = 'fan';}
  else if (weaponType === WeaponType.Lightning || weaponType === WeaponType.Repair) {kind = 'beam';}
  return {
    weaponType, rate, config, kick,
    kind,`);

ed('client/src/world/mapStructures.ts',
`const nOut = s.kind === 'kit' ? (KIT_HULLS[s.piece ?? '']?.length ?? 0)
        : s.kind === 'root' ? 2 : 1;`,
`let nOut = 1;
      if (s.kind === 'kit') {nOut = KIT_HULLS[s.piece ?? '']?.length ?? 0;}
      else if (s.kind === 'root') {nOut = 2;}`);

ed('server_bun/src/RoomDeployables.ts',
`const armDelay = k === 'turret' ? TURRET_UNFOLD_S + this.room.rng() * 0.4
      : k === 'mine' ? MINE_ARM_S
      : k === 'station' ? STATION_HEAL_CD : 0;`,
`let armDelay = 0;
    if (k === 'turret') {armDelay = TURRET_UNFOLD_S + this.room.rng() * 0.4;}
    else if (k === 'mine') {armDelay = MINE_ARM_S;}
    else if (k === 'station') {armDelay = STATION_HEAL_CD;}`);

ed('server_bun/src/botArsenal.ts',
`const movingCap = surge ? (strike ? 50 : 55) : 12;`,
`let movingCap = 12;
  if (surge) {movingCap = strike ? 50 : 55;}`);

ed('server_bun/src/botArsenal.ts',
`this.propelT.set(id, now + (surge ? (strike ? 2200 : 2200) : 8000));`,
`this.propelT.set(id, now + (surge ? 2200 : 8000));`);

ed('server_bun/src/botRoster.ts',
`const loadout = process.env.FPS_SOAK_RANDLO === '1'
        ? { perk: 'vitality' as const, near: pickOf(RANDLO.near), mid: pickOf(RANDLO.mid), far: pickOf(RANDLO.far), belt: pickOf(RANDLO.belt), side: pickOf(RANDLO.side) }
        : wildcard
          ? rollWildcard(botRand)
          : BOT_LOADOUTS[kitIdx]!;`,
`let loadout;
      if (process.env.FPS_SOAK_RANDLO === '1') {loadout = { perk: 'vitality' as const, near: pickOf(RANDLO.near), mid: pickOf(RANDLO.mid), far: pickOf(RANDLO.far), belt: pickOf(RANDLO.belt), side: pickOf(RANDLO.side) };}
      else {loadout = wildcard ? rollWildcard(botRand) : BOT_LOADOUTS[kitIdx]!;}`);

ed('server_bun/src/roomMatch.ts',
`return s.alpha === s.bravo ? null : s.alpha > s.bravo ? 'alpha' : 'bravo';`,
`if (s.alpha === s.bravo) {return null;}
      return s.alpha > s.bravo ? 'alpha' : 'bravo';`);

ed('server_bun/src/roomMatch.ts',
`w = s.alpha === s.bravo ? 'draw' : s.alpha > s.bravo ? 'alpha' : 'bravo';`,
`if (s.alpha === s.bravo) {w = 'draw';}
      else {w = s.alpha > s.bravo ? 'alpha' : 'bravo';}`);

ed('server_bun/src/serverSenses.ts',
`? d < 160 || botRand() < (d < 260 ? 0.6 : d < 320 ? 0.3 : 0.08)`,
`? d < 160 || botRand() < nuggetChance(d)`);

ed('server_bun/src/serverSenses.ts',
`    const nuggets = this.room.mode === 'nuggets';`,
`    const nuggets = this.room.mode === 'nuggets';
    const nuggetChance = (d: number): number => {
      if (d < 260) {return 0.6;}
      if (d < 320) {return 0.3;}
      return 0.08;
    };`);

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

ed('shared/botBrain.ts',
`return huntNow === ctx.thief?.id ? { kind: 'thief', target: huntNow, d: this.dirTag(ctx, ctx.thief.pos) }
        : huntNow.startsWith('b:') ? undefined
        : { kind: 'contact', target: huntNow, d: this.dirTag(ctx) };`,
`if (huntNow === ctx.thief?.id) {return { kind: 'thief', target: huntNow, d: this.dirTag(ctx, ctx.thief.pos) };}
      if (huntNow.startsWith('b:')) {return undefined;}
      return { kind: 'contact', target: huntNow, d: this.dirTag(ctx) };`);

ed('shared/botClasses.ts',
`return HEAVY_ONLY_WEAPONS.has(w) ? 'heavy' : MEDIUM_ONLY_WEAPONS.has(w) ? 'medium' : 'light';`,
`if (HEAVY_ONLY_WEAPONS.has(w)) {return 'heavy';}
  if (MEDIUM_ONLY_WEAPONS.has(w)) {return 'medium';}
  return 'light';`);

ed('shared/botGraph.ts',
`const ti = team === 'alpha' ? 0 : team === 'bravo' ? 1 : 2;`,
`let ti = 2;
if (team === 'alpha') {ti = 0;}
else if (team === 'bravo') {ti = 1;}`);

ed('shared/botLos.ts',
`const t = ctx.team === 'alpha' ? 1 : ctx.team === 'bravo' ? 2 : 0;`,
`let t = 0;
if (ctx.team === 'alpha') {t = 1;}
else if (ctx.team === 'bravo') {t = 2;}`);

ed('shared/botSheep.ts',
`const base = s.dt * (tribesing
      ? -Math.min(12 + bonusSpeed * 0.6 + (s.jetting ? 15 : 0), 30)
      : excused ? 2 : s.hasDest ? 9 : 18);`,
`let drain = 18;
    if (excused) {drain = 2;}
    else if (s.hasDest) {drain = 9;}
    const base = s.dt * (tribesing
      ? -Math.min(12 + bonusSpeed * 0.6 + (s.jetting ? 15 : 0), 30)
      : drain);`);

ed('shared/combat.ts',
`return n <= 4 ? 4 : n <= 9 ? 3 : 2;`,
`if (n <= 4) {return 4;}
if (n <= 9) {return 3;}
return 2;`);

ed('shared/movement.ts',
`this.wishJump = MOVEMENT_CONFIG.autoHop
      ? this.input.jumpHeld
      : (this.input.jumpPressed ? true : this.wishJump && this.input.jumpHeld);`,
`if (MOVEMENT_CONFIG.autoHop) {this.wishJump = this.input.jumpHeld;}
    else if (this.input.jumpPressed) {this.wishJump = true;}
    else {this.wishJump = this.wishJump && this.input.jumpHeld;}`);

ed('shared/botDisposition.ts',
`const kind: string = (ctx.healthFrac ?? 1) < 0.4 ? 'station'
      : roll < 0.55 ? 'turret' : roll < 0.85 ? 'mine' : 'drone';`,
`let kind = 'drone';
    if ((ctx.healthFrac ?? 1) < 0.4) {kind = 'station';}
    else if (roll < 0.55) {kind = 'turret';}
    else if (roll < 0.85) {kind = 'mine';}`);

ed('client/src/entities/Rakk.ts',
`this.state = b.state === 'windup' ? 'dive' : b.state === 'orbit' ? 'orbit' : 'climb';`,
`this.state = 'climb';
    if (b.state === 'windup') {this.state = 'dive';}
    else if (b.state === 'orbit') {this.state = 'orbit';}`);

ed('client/src/entities/Tumbleweed.ts',
`d.addScaledVector(_radial, r > 0.9 ? -0.5 : r < 0.3 ? 0.4 : 0);`,
`let push = 0;
    if (r > 0.9) {push = -0.5;}
    else if (r < 0.3) {push = 0.4;}
    d.addScaledVector(_radial, push);`);

ed('client/src/game/loopPerf.ts',
`  setVfxQualityScale(next >= 4 ? 0.45 : (next >= 2 ? 0.7 : 1));`,
`  let vfxScale = 1;
  if (next >= 4) {vfxScale = 0.45;}
  else if (next >= 2) {vfxScale = 0.7;}
  setVfxQualityScale(vfxScale);`);

ed('client/src/demo/VideoRecorder.ts',
`const meta = i === keyIdx
        ? (r.m?.decoderConfig ? r.m : this.decConf ? { decoderConfig: this.decConf } : r.m)
        : undefined;`,
`let meta;
      if (i === keyIdx) {
        meta = r.m;
        if (!meta?.decoderConfig && this.decConf) {meta = { decoderConfig: this.decConf };}
      }`);

ed('client/src/demo/VideoRecorder.ts',
`const meta = firstAudio
          ? (r.m?.decoderConfig ? r.m : this.aDecConf ? { decoderConfig: this.aDecConf } : r.m)
          : undefined;`,
`let meta;
        if (firstAudio) {
          meta = r.m;
          if (!meta?.decoderConfig && this.aDecConf) {meta = { decoderConfig: this.aDecConf };}
        }`);

console.log('done');
