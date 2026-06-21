import * as BABYLON from '@babylonjs/core';

// Physics Constants (Tribes-style)
export const GRAVITY = new BABYLON.Vector3(0, -20, 0);
export const GRAVITY_MAGNITUDE = 20;

// Tribes 1 Physics Constants
export const TRIBES_TICKS_PER_SECOND = 31.25;
export const TRIBES_TICK_LENGTH = 1.0 / TRIBES_TICKS_PER_SECOND;

// Armor stats (light armor - scout)
export const ARMOR_WALKSPEED = 7; // m/s
export const ARMOR_JUMPIMPULSE = 9; // m/s
export const ARMOR_MASS = 0.8; // kg
export const ARMOR_MAXENERGY = 60;
export const ARMOR_JETENERGY_DRAIN = 12; // energy per second
export const ARMOR_JETENERGY_CHARGE = 8; // energy per second
export const JET_FORCE = 28; // m/s²
export const CRAWLTOSTOP = 0.5; // m/s
export const MAXJUMPTICKS = 8; // 256ms / 32ms = 8 ticks
