import type * as THREE from 'three';

import { AmbientParticles, type AmbientKind } from './ambientParticles.js';
import type { Terrain } from '../world/terrain.js';

// Per-map ambient weather — one owner for the world-particle layers, so a
// map's `weather` block and the dynamic-quality switch can't fight over the
// same cloud's visibility. Before this, main.ts spawned all three historic
// kinds on EVERY map (embers glowing on sand, ash falling on grass). Absent
// weather restores exactly that default trio so maps that predate the field
// are byte-for-byte unchanged.
const KINDS: AmbientKind[] = ['dust', 'embers', 'ash', 'snow'];

/** Intensity per kind, 0..2 (>1 thickens). Missing kind = off. */
export type WeatherSpec = Partial<Record<AmbientKind, number>>;

/** The pre-`weather` behavior, kept as the fallback. */
const DEFAULT: WeatherSpec = { dust: 1, embers: 1, ash: 1 };

export class AmbientWeather {
  private layers: { kind: AmbientKind; fx: AmbientParticles }[] = [];
  private spec: WeatherSpec = DEFAULT;
  private qualityOn = true;

  constructor(scene: THREE.Scene) {
    for (const kind of KINDS) {
      this.layers.push({ kind, fx: new AmbientParticles(scene, kind) });
    }
    this.apply();
  }

  /** Map-driven. `undefined`/`null` restores the default trio. */
  setWeather(spec: WeatherSpec | null | undefined): void {
    this.spec = spec ?? DEFAULT;
    this.apply();
  }

  /** Dynamic-quality switch — composes with the weather mask instead of
   *  clobbering it (a quality wake-up must not resurrect a disabled kind). */
  setQuality(on: boolean): void {
    this.qualityOn = on;
    this.apply();
  }

  private apply(): void {
    for (const { kind, fx } of this.layers) {
      const intensity = this.spec[kind] ?? 0;
      fx.setIntensity(intensity);
      fx.setActive(this.qualityOn && intensity > 0);
    }
  }

  update(dt: number, camPos: THREE.Vector3, terrain: Terrain): void {
    for (const { fx } of this.layers) {fx.update(dt, camPos, terrain);}
  }
}
