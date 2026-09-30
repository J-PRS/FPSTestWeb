import * as THREE from 'three';
import { isDown } from '../core/keybinds.js';
import type { Player } from './Player.js';

// Key state -> move intent: yaw-projected basis vectors, the polled
// input snapshot the movement step consumes, and the aim ray.

export function getForwardXZ(p: Player): THREE.Vector2 {
    return new THREE.Vector2(Math.sin(p.yaw), Math.cos(p.yaw));
  }
export function getRightXZ(p: Player): THREE.Vector2 {
    return new THREE.Vector2(-Math.cos(p.yaw), Math.sin(p.yaw));
  }

export function getInputState(p: Player): { forward: number; right: number; jumpPressed: boolean; jumpHeld: boolean; skiHeld: boolean; firePressed: boolean; jetHeld: boolean; beltHeld: boolean } {
    const keys = p.input.keys;
    let forward = 0, right = 0;
    if (isDown(keys, 'forward') || keys['ArrowUp'])    forward += 1;
    if (isDown(keys, 'back') || keys['ArrowDown'])     forward -= 1;
    if (isDown(keys, 'left') || keys['ArrowLeft'])     right -= 1;
    if (isDown(keys, 'right') || keys['ArrowRight'])   right += 1;

    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward,
      right,
      jumpPressed: p.input.jumpHeld,
      jumpHeld: p.input.jumpHeld,
      skiHeld: isDown(keys, 'ski'),
      firePressed: p.input.firePending,
      jetHeld: p.input.jetPending,
      beltHeld: p.input.beltHeld,
    };
  }

export function readMoveInput(p: Player): { forward: number; right: number; jumpHeld: boolean; skiHeld: boolean; moveX: number; moveZ: number } {
    const fwd = getForwardXZ(p);
    const rgt = getRightXZ(p);
    const keys = p.input.keys;

    let forward = 0, right = 0;
    if (isDown(keys, 'forward') || keys['ArrowUp'])    forward += 1;
    if (isDown(keys, 'back') || keys['ArrowDown'])     forward -= 1;
    if (isDown(keys, 'left') || keys['ArrowLeft'])     right -= 1;
    if (isDown(keys, 'right') || keys['ArrowRight'])   right += 1;

    // Normalize input
    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward, right,
      jumpHeld: p.input.jumpHeld, // autoHop: held = pressed
      skiHeld: isDown(keys, 'ski'),
      // World-space move dir for jetpack thrust
      moveX: fwd.x * forward + rgt.x * right,
      moveZ: fwd.y * forward + rgt.y * right,
    };
  }

export function getAimDir(p: Player): THREE.Vector3 {
    return new THREE.Vector3(
      Math.cos(p.pitch) * Math.sin(p.yaw),
      Math.sin(p.pitch),
      Math.cos(p.pitch) * Math.cos(p.yaw)
    ).normalize();
  }

