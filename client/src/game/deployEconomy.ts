/**
 * Deploy-belt economy — the pure math behind throwing a pack item.
 *
 * A pack item is a *thrown pod*: it leaves the hand, arcs, and only seats
 * once it lands. The belt charge is spent on the throw (the same beat a
 * belt throw pays), so the gate has to count pods already in the air — a
 * pod in flight is a plant you've committed to, before it seats. Charging
 * on touchdown instead let a high tosser stack free pods: every airborne
 * throw still saw a full belt and slipped both the cost and the kind cap.
 */
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
import type { DeployKind } from '../../../shared/deployables.js';

/** Belt charge a pack item costs — the shared per-kind table the server
 *  bills handleDeploy against (turret 2, mortar 3, …). */
export function packCost(kind: DeployKind): number {
  return DEPLOY_ITEMS[kind].cost;
}

/** Can the selected pack item leave the hand? `seated` = your live items
 *  of the kind, `airborne` = pods of the kind still in flight. A throw is
 *  legal when the belt can pay AND a cap slot is free — or a seated item
 *  exists to recycle (retiring the oldest is the caller's job; an
 *  all-airborne stack has nothing to recycle and waits to touch down). */
export function canThrowPack(beltCharges: number, cost: number, seated: number, airborne: number, cap: number): boolean {
  if (beltCharges < cost) {return false;}
  return seated + airborne < cap || seated > 0;
}

/** At the moment a pod leaves the hand, should it retire your oldest seated
 *  item of the kind? True when the kind is at (or over) cap and there is a
 *  seated item to recycle. Run at release, not at the keypress gate, so a
 *  death/dry abort in the wind-up can't destroy a plant for free. */
export function recyclesSeated(seated: number, airborne: number, cap: number): boolean {
  return seated > 0 && seated + airborne >= cap;
}
