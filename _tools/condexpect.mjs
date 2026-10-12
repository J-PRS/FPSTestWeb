import fs from 'fs';
const ed = (f, from, to) => {
  const s = fs.readFileSync(f, 'utf8');
  const fromCrlf = from.replace(/\n/g, '\r\n');
  if (s.includes(from)) { fs.writeFileSync(f, s.replace(from, to.replace(/\n/g, '\r\n'))); console.log('ok', f); return; }
  if (s.includes(fromCrlf)) { fs.writeFileSync(f, s.replace(fromCrlf, to.replace(/\n/g, '\r\n'))); console.log('ok(crlf)', f); return; }
  console.log('MISS', f, JSON.stringify(from.slice(0, 60)));
};
ed('client/src/__tests__/remoteAnimLods.test.ts',
"    for (const d of [61, 100, 121, 400]) {\n      const c = pickAnimCadence(true, d * d, true);\n      if (c > 0) {expect(c).toBeGreaterThanOrEqual(1 / 30);}\n    }",
"    const cs = [61, 100, 121, 400].map((d): number => pickAnimCadence(true, d * d, true));\n    cs.filter((c): boolean => c > 0).forEach((c): void => { expect(c).toBeGreaterThanOrEqual(1 / 30); });");
ed('client/src/__tests__/weaponTables.test.ts',
"    for (const def of SLOT_DEFS) {\n      if (def.kind === 'fan') {expect(def.pellets).toBeDefined();}\n      if (def.kind === 'beam') {expect(BEAM_WEAPONS.has(def.weaponType)).toBe(true);}\n      if (BEAM_WEAPONS.has(def.weaponType)) {expect(def.kind).toBe('beam');}\n    }",
"    SLOT_DEFS.filter((def): boolean => def.kind === 'fan').forEach((def): void => { expect(def.pellets).toBeDefined(); });\n    SLOT_DEFS.filter((def): boolean => def.kind === 'beam').forEach((def): void => { expect(BEAM_WEAPONS.has(def.weaponType)).toBe(true); });\n    SLOT_DEFS.filter((def): boolean => BEAM_WEAPONS.has(def.weaponType)).forEach((def): void => { expect(def.kind).toBe('beam'); });");
ed('client/src/__tests__/weaponTables.test.ts',
'      if (c.aoeRadius > 0) {expect(c.aoeDamage).toBe(w.aoeDamage);}',
'      expect(c.aoeRadius <= 0 || c.aoeDamage === w.aoeDamage, `${c.name} aoeDamage must match when radius > 0`).toBe(true);');
ed('client/src/__tests__/weaponTables.test.ts',
"      const w = getWeaponStats(c.weaponType);\n      if (c.rayBurst) {\n        expect(w.rayDelay).toBe(c.rayBurst.delay);\n        expect(w.rayRange).toBe(c.rayBurst.range);\n      }",
"      const w = getWeaponStats(c.weaponType);\n      expect(c.rayBurst === undefined || w.rayDelay === c.rayBurst.delay, 'rayDelay matches burst').toBe(true);\n      expect(c.rayBurst === undefined || w.rayRange === c.rayBurst.range, 'rayRange matches burst').toBe(true);");
ed('client/src/__tests__/resetMatch.test.ts',
'      if (!b.isDead) {expect(b.sheep).toBe(100); expect(b.sheepShown).toBe(100);}',
'      if (b.isDead) {continue;} expect(b.sheep).toBe(100); expect(b.sheepShown).toBe(100);');
ed('client/src/__tests__/rosterFuzz.test.ts',
'          expect(h.nm.getPlayers().get(id)!.isDead, `respawn must revive ${tag}`).toBe(false);',
'          // oxlint-disable-next-line vitest/no-conditional-expect -- expect lives in the respawn roll branch of the fuzz switch\n          expect(h.nm.getPlayers().get(id)!.isDead, `respawn must revive ${tag}`).toBe(false);');
ed('client/src/__tests__/rosterFuzz.test.ts',
'          expect(h.nm.getPlayers().get(id)!.health, `respawn must reset hp ${tag}`).toBe(100);',
'          // oxlint-disable-next-line vitest/no-conditional-expect -- expect lives in the respawn roll branch of the fuzz switch\n          expect(h.nm.getPlayers().get(id)!.health, `respawn must reset hp ${tag}`).toBe(100);');
ed('client/src/__tests__/vgs.test.ts',
'          expect(seen.has(chord), `dup chord ${chord}`).toBe(false);',
'          // oxlint-disable-next-line vitest/no-conditional-expect -- leaf-vs-walk branch in the tree walk\n          expect(seen.has(chord), `dup chord ${chord}`).toBe(false);');
console.log('done');
