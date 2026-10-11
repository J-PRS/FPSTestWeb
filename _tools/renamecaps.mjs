import fs from 'fs';
const ren = (f, pairs) => {
  let s = fs.readFileSync(f, 'utf8');
  for (const [from, to] of pairs) {
    s = s.replace(new RegExp('(?<![\\w$.])' + from + '\\(', 'g'), to + '(');
    s = s.replace(new RegExp('\\bconst ' + from + ' =', 'g'), 'const ' + to + ' =');
  }
  fs.writeFileSync(f, s);
  console.log(f, 'done');
};
ren('client/src/__tests__/rosterHeal.test.ts', [['P', 'pt']]);
ren('client/src/__tests__/rosterFuzz.test.ts', [['GS', 'gs']]);
ren('client/src/core/visAudit.ts', [['X', 'mX'], ['Y', 'mY'], ['Z', 'mZ']]);
ren('shared/botBrain.ts', [['P', 'pm']]);
ren('client/src/effects/RibbonTrail.ts', [['JUMP_BUDGET', 'jumpBudget']]);
ren('client/src/game/combat/projectiles.ts', [['AOE_DEBUG', 'aoeDebug']]);
ren('client/src/entities/viewmodel/weaponKit.ts', [['O', 'oPt'], ['I', 'iPt']]);
