/**
 * Animation coverage matrix — every (variant × state × direction) must
 * resolve to a clip the rig can actually play. A miss used to mean a
 * silent bind-pose/idle-hold window (cyber ski, vexa forward walk).
 *
 * Mirror of PlayerModel.forceAnimationState's cascade, run over clip
 * inventories parsed from the real GLBs plus the UAL_* names each
 * variant's retarget specs would bake. If the cascade changes, update
 * the resolver below — the point is that a gap fails LOUDLY here, not
 * as a frozen pose in game.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clipCandidates,
  type AnimationState, type LocoDir,
} from '../entities/playerClips.js';

const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/assets/models');

function clipNames(file: string): Set<string> {
  const buf = fs.readFileSync(path.join(MODELS_DIR, file));
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  return new Set((json.animations || []).map((a: { name: string }) => a.name));
}

const STATES: AnimationState[] = ['idle', 'walk', 'run', 'jump', 'death', 'ski', 'hit', 'shoot', 'jet'];

// variant → its GLB + the retarget sources its rig is wired to (SPECS
// variants filters, distilled — keep in sync with playerUal.SPECS).
const RIGS: Record<string, { glb: string; sources: string[] }> = {
  robot:        { glb: 'RobotExpressive.glb', sources: ['robot-anims.glb', 'robot-anims2.glb', 'kevdev-anims.glb'] },
  mannequin:    { glb: 'mannequin.glb',       sources: ['kevdev-anims.glb'] },
  knight:       { glb: 'knight.glb',          sources: ['kevdev-anims.glb'] },
  scifisoldier: { glb: 'class_light.glb',     sources: ['kevdev-anims.glb'] },
  cybersoldier: { glb: 'class_cyber.glb',     sources: ['kevdev-anims.glb', 'mannequin.glb'] },
  vexa:         { glb: 'class_medium.glb',    sources: ['kevdev-anims.glb'] },
  polyart:      { glb: 'class_heavy.glb',     sources: ['kevdev-anims.glb'] },
};

function available(variant: string): Set<string> {
  const rig = RIGS[variant]!;
  const natives = clipNames(rig.glb);
  const out = new Set(natives);
  if (variant === 'mannequin') {
    // registerClip self-aliases mannequin's natives to UAL_ names.
    for (const n of natives) out.add('UAL_' + n);
  }
  for (const src of rig.sources) {
    for (const n of clipNames(src)) out.add('UAL_' + n);
  }
  return out;
}

/** First candidate the loaded set actually has — the runtime walks the
 *  same list, so this can never drift from what ships. */
function resolveClip(avail: Set<string>, variant: string, state: AnimationState, dir: LocoDir): string | null {
  const hit = clipCandidates(variant, state, dir).find(c => avail.has(c.name));
  return hit ? hit.name : null;
}

describe('anim coverage matrix — every variant resolves every state to a real clip', () => {
  const dirs: LocoDir[] = ['F', 'L'];
  for (const variant of Object.keys(RIGS)) {
    const avail = available(variant);
    for (const state of STATES) {
      for (const dir of dirs) {
        it(`${variant} ${state} ${dir}`, () => {
          const clip = resolveClip(avail, variant, state, dir);
          expect(clip, `${variant}/${state}/${dir} resolved to nothing`).not.toBeNull();
          expect(avail.has(clip!), `${variant}/${state}/${dir} → '${clip}' not in clip set`).toBe(true);
        });
      }
    }
  }
});
