/**
 * weather.ts — per-map weather / atmosphere / terrain-palette regression.
 *
 *   bun _tools/e2e/weather.ts [map...]
 *
 * The scene-code gate (`check.sh`) only ever shoots ONE map, so a new
 * `weather` / `atmosphere` / `terrainPreset` block was invisible to it: a
 * GLSL typo in preset 6, a dropped weather kind, or a room hop that
 * inherits the previous map's tint all passed green. This walks the real
 * client through the maps and reads the live uniforms + particle draw
 * ranges against the specs, then writes a PNG per map (READ THEM — the
 * numbers prove the wiring, only the eye proves it looks right).
 *
 * Sequence: boot on the CONTROL map (no weather/atmosphere block) to
 * baseline the sky uniforms, then hop to each spec map and back again —
 * the return leg is the regression that matters most (a room hop must
 * restore the default trio + boot sky, not keep the last map's snow).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MAPS_DIR = join(REPO, 'maps');
const SHOTS = join(REPO, '_tools/e2e/shots');

/** Control first: a spec with no weather/atmosphere blocks at all. */
const DEFAULT_CHAIN = ['hills', 'whiteout', 'caldera', 'rimrock', 'lagoon', 'hills'];
const CHAIN = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CHAIN;

/** Particle pool sizes in client/src/effects/ambientParticles.ts — the
 *  position-attribute count is the only way to tell the four layers apart
 *  from outside (AmbientWeather owns them, the Points objects don't). */
const COUNTS: Record<number, string> = { 220: 'dust', 60: 'embers', 120: 'ash', 380: 'snow' };
/** kind → pool size, for turning a spec intensity into a draw range. */
const POOL: Record<string, number> = { dust: 220, embers: 60, ash: 120, snow: 380 };

interface Spec { terrainPreset?: number; weather?: Record<string, number>; atmosphere?: Record<string, number> }
const readSpec = (name: string): Spec => {
  try { return JSON.parse(readFileSync(join(MAPS_DIR, `${name}.json`), 'utf8')) as Spec; }
  catch { return {}; }
};

const BOOT_SKY = { rayleigh: 1, mieCoefficient: 21e-6, starIntensity: 0.9 };

/** What the client should show for `name`, given the baseline sky. */
function expectFor(name: string, baseSun: number): {
  preset?: number;
  draw: Record<string, number>;
  sky: Record<string, number>;
} {
  const s = readSpec(name);
  const draw: Record<string, number> = { dust: 0, embers: 0, ash: 0, snow: 0 };
  // Absent weather = the historic default trio, still on.
  const w = s.weather ?? { dust: 1, embers: 1, ash: 1 };
  for (const [k, v] of Object.entries(w)) {
    if (POOL[k] !== undefined) {draw[k] = Math.round(POOL[k] * Math.min(1, v));}
  }
  const a = s.atmosphere ?? {};
  // sunIntensity is radiance × elevation × specMult — model timeOfDay or
  // a dusk spec reads as a dimming bug. baseSun is the boot read at t=0.38.
  const baseElev = Math.max(0, Math.sin((0.38 - 0.25) * Math.PI * 2));
  const elev = Math.max(0, Math.sin(((a.timeOfDay ?? 0.38) - 0.25) * Math.PI * 2));
  const elevScale = elev > 0 ? elev / baseElev : 0.09 / baseElev;
  const sky = { ...BOOT_SKY, sunIntensity: baseSun * elevScale * (a.sunIntensity ?? 1) };
  if (a.rayleigh !== undefined) {sky.rayleigh = a.rayleigh;}
  if (a.mie !== undefined) {sky.mieCoefficient = 21e-6 * a.mie;}
  if (a.starIntensity !== undefined) {sky.starIntensity = a.starIntensity;}
  return { preset: s.terrainPreset, draw, sky };
}

/** Hop through one room and read the live scene state back. */
function hopExpr(room: string): string {
  return `(async () => {
    const t = window.__test;
    const prev = t.world.onTerrainApplied;
    // Restore prev when we resolve — hops must not stack handlers (each
    // one would re-fire the whole chain on the next terrain swap).
    const applied = new Promise((res) => {
      t.world.onTerrainApplied = (f) => {
        t.world.onTerrainApplied = prev;
        if (prev) prev(f);
        res();
      };
    });
    t.networkManager.switchRoom(${JSON.stringify(room)});
    await Promise.race([applied, new Promise((r) => setTimeout(r, 15000))]);
    await new Promise((r) => setTimeout(r, 2500));
    const sky = t.scene.getObjectByName('__sky');
    const su = sky && sky.userData.sky ? sky.material.uniforms : null;
    // Uniform reads must be soft — a baked skybox tags __sky too but its
    // material has no rayleigh/mie/star slots (procedural-only uniforms).
    const skyOut = su ? {
      rayleigh: su.rayleigh?.value,
      mieCoefficient: su.mieCoefficient?.value,
      starIntensity: su.starIntensity?.value,
      sunIntensity: su.sunIntensity?.value,
    } : null;
    const ambient = [];
    t.scene.traverse((o) => {
      if (o.userData && o.userData.dbg && o.userData.dbg.label === 'ambientParticles') {
        ambient.push({ n: o.geometry.getAttribute('position').count,
          draw: o.geometry.drawRange.count,
          opacity: o.material.opacity, visible: o.visible });
      }
    });
    // The palette is a #define (TERRAIN_PRESET) + terrain.preset — not a
    // uniform. levels[0].uniforms only carries height/scale channels.
    const preset = t.terrain && typeof t.terrain.preset === 'number' ? t.terrain.preset : null;
    return { map: t.world.mapName, preset, sky: skyOut, ambient };
  })()`;
}

/** Frame the shot from a fixed high vantage pitched at the sky — the
 *  particles live in a 30m shell around the camera, and a random spawn
 *  can land inside fog/against a wall, which makes the PNGs (the part a
 *  human has to read) useless for comparing weather across runs. */
function frameExpr(): string {
  return `(() => {
    const t = window.__test;
    const p = t.player;
    const h = t.terrain && t.terrain.heightAt ? t.terrain.heightAt(0, 0) : 60;
    p.pos.set(0, h + 45, 0);
    p.vel.set(0, 0, 0);
    p.yaw = 0.9; p.pitch = 0.3;
    p.syncMovement && p.syncMovement();
    p.markTeleport && p.markTeleport();
  })()`;
}

/** One snapshot of the live scene, read after `hopExpr`. */
interface Snap {
  map?: string; preset: number | null;
  sky: Record<string, number> | null;
  ambient: { n: number; draw: number; opacity: number; visible: boolean }[];
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

const stack = await upStack();
const first = CHAIN[0]!;
// Pin the dynamic-quality ladder OFF: under sustained low fps (SwiftShader
// especially) autoScaleCpu sheds the ambient particle layers, so without
// this every weather assertion + screenshot depends on the frame rate.
const client = await launchClient(stack.clientUrl(`&room=${first}&bots=0&net=ws`), {
  preload: `localStorage.setItem('fps-autoq','false')`,
});
let failed = 0;

try {
  await client.waitFor('t.player && t.player.pos', 30000);
  const control = await client.page.evaluate(hopExpr(first)) as Snap;
  await new Promise((r) => setTimeout(r, 1200));
  await client.page.evaluate(frameExpr());
  await new Promise((r) => setTimeout(r, 1200));
  await client.page.screenshot({ path: join(SHOTS, `weather_${first}.png`) });
  // The control map defines the boot sky every other map multiplies.
  const baseSun = control.sky?.sunIntensity ?? 22;
  console.log(`control ${first}: preset=${control.preset} sky=${JSON.stringify(control.sky)}`);

  for (let i = 1; i < CHAIN.length; i += 1) {
    const name = CHAIN[i]!;
    const snap = await client.page.evaluate(hopExpr(name)) as Snap;
    await new Promise((r) => setTimeout(r, 1200));
    await client.page.evaluate(frameExpr());
    await new Promise((r) => setTimeout(r, 1200));
    await client.page.screenshot({ path: join(SHOTS, `weather_${name}.png`) });
    const want = expectFor(name, baseSun);
    const bad: string[] = [];
    // A hop back to the control map must restore the BOOT sky + default
    // trio — that is the room-hop inheritance regression.
    const wantSky = name === first ? control.sky! : want.sky;

    if (want.preset !== undefined && snap.preset !== want.preset) { bad.push(`preset ${snap.preset} != ${want.preset}`); }
    for (const [k, v] of Object.entries(wantSky)) {
      const got = snap.sky?.[k];
      if (got === undefined || !near(got, v, v === 0 ? 1e-9 : Math.max(Math.abs(v) * 0.02, 1e-7))) {
        bad.push(`sky.${k} ${got} != ${v}`);
      }
    }
    for (const k of Object.keys(want.draw)) {
      const layer = snap.ambient.find((a) => COUNTS[a.n] === k);
      const draw = layer ? layer.draw : -1;
      if (draw !== want.draw[k]) { bad.push(`${k} draw ${draw} != ${want.draw[k]}`); }
    }
    const zeroed = snap.ambient.filter((a) => COUNTS[a.n] && want.draw[COUNTS[a.n]!] === 0 && a.visible);
    if (zeroed.length) { bad.push(`off kinds still visible: ${zeroed.map((z) => COUNTS[z.n]).join(',')}`); }
    // The quality ladder composes with the weather mask — a dialed kind
    // must actually be on screen, or a map's weather is decor.
    for (const k of Object.keys(want.draw)) {
      if (want.draw[k] === 0) {continue;}
      const layer = snap.ambient.find((a) => COUNTS[a.n] === k);
      if (!layer || !layer.visible) { bad.push(`${k} dialed but not visible`); }
    }

    if (bad.length) { failed += 1; console.log(`  FAIL ${name}: ${bad.join(' | ')}`); }
    else { console.log(`  ok   ${name}: preset=${snap.preset} ambient=${snap.ambient.map((a) => `${COUNTS[a.n] ?? a.n}:${a.draw}`).join(' ')}`); }
  }
  console.log(`\n  ${CHAIN.length - 1} hops · ${failed} failed · shots in ${SHOTS}`);
} finally {
  await closeClient(client);
  stack.down();
}

process.exit(failed ? 1 : 0);
