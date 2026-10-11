// Shared deployable vitality + unfold ease — one copy of the armor-soak
// and easeOutBack rules every placed deployable re-typed per class.
// Per-entity hooks (mast rise, pillar reveal, placed flag) stay in the
// delegating method bodies.
import type * as THREE from 'three';

export interface DeployBody {
  unfoldT: number;
  health: number;
  maxHealth: number;
  armor: number;
  dead: boolean;
  group: THREE.Group;
}

export function tickUnfold(d: DeployBody, dt: number): void {
  if (d.unfoldT >= 1) {return;}
  d.unfoldT = Math.min(1, d.unfoldT + dt / 0.45);
  const k = d.unfoldT - 1;
  d.group.scale.setScalar(Math.max(0.08, 1 + 2.7 * k * k * k + 1.7 * k * k)); // easeOutBack
}

export function unfoldDone(d: DeployBody): void {
  d.unfoldT = 1;
  d.group.scale.setScalar(1);
}

/** Repair beam: heal refills health first, overflow banks as armor. */
export function healDeploy(d: DeployBody, n: number): void {
  const over = Math.max(0, d.health + n - d.maxHealth);
  d.health = Math.min(d.maxHealth, d.health + n);
  d.armor = Math.min(d.maxHealth * 2, d.armor + over);
}

export function damageDeploy(d: DeployBody, dmg: number): void {
  if (d.dead) {return;}
  const soak = Math.min(d.armor, dmg);
  d.armor -= soak;
  d.health -= dmg - soak;
  if (d.health <= 0) {d.dead = true;}
}
