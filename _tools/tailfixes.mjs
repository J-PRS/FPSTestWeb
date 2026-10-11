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

ed('client/src/core/stateDebug.ts',
  "import type { ChildLogger } from './Logger.js';\nimport { Logger } from './Logger.js';",
  "import { Logger, type ChildLogger } from './Logger.js';");

ed('client/src/effects/RibbonTrail.ts',
  "import type {\n  TrailBatch} from './trailBatch.js';\nimport { RIBBON_SAMPLES,",
  "import { type TrailBatch, RIBBON_SAMPLES,");

ed('client/src/demo/demoClip.ts',
  "import type {\n  ProjectileEvent, TargetEvent, RemoteFrame} from './types.js';\nimport {\n  ProjectileEventType, TargetEventType, TARGETTYPE_KILL,\n} from './types.js';",
  "import {\n  ProjectileEventType, TargetEventType, TARGETTYPE_KILL,\n  type ProjectileEvent, type TargetEvent, type RemoteFrame,\n} from './types.js';");

ed('client/src/effects/vfx.ts',
  "} from 'three.quarks';\nimport type { FunctionValueGenerator, GeneratorMemory, FunctionJSON } from 'three.quarks';",
  ",\n  type FunctionValueGenerator, type GeneratorMemory, type FunctionJSON,\n} from 'three.quarks';");

ed('client/src/core/renderer.ts',
  "import type {\n  Pass} from 'postprocessing';\nimport {\n  Effect,",
  "import {\n  type Pass,\n  Effect,");

ed('server_bun/src/deployTicks.ts',
  "import type { Deployed, RoomDeployables } from './RoomDeployables.ts';\nimport {\n  TURRET_RANGE,",
  "import {\n  type Deployed, type RoomDeployables,\n  TURRET_RANGE,");

ed('server_bun/src/botRouting.ts',
  "import type { Heightfield } from '../../shared/heightfield.ts';\nimport { hmHeight } from '../../shared/heightfield.ts';",
  "import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';");
