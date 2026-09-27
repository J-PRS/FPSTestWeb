import { CONFIG } from './config.ts';
import type { ClientMessage, Vec3, Rotation } from './types.ts';

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateVec3(value: unknown): ValidationResult<Vec3> {
  if (typeof value !== 'object' || value === null) {
    return { success: false, error: 'Expected object' };
  }
  const obj = value as Record<string, unknown>;
  if (!isFiniteNumber(obj.x) || !isFiniteNumber(obj.y) || !isFiniteNumber(obj.z)) {
    return { success: false, error: 'Expected { x, y, z } as finite numbers' };
  }
  return { success: true, data: { x: obj.x, y: obj.y, z: obj.z } };
}

function validateRotation(value: unknown): ValidationResult<Rotation> {
  if (typeof value !== 'object' || value === null) {
    return { success: false, error: 'Expected object' };
  }
  const obj = value as Record<string, unknown>;
  if (!isFiniteNumber(obj.yaw) || !isFiniteNumber(obj.pitch)) {
    return { success: false, error: 'Expected { yaw, pitch } as finite numbers' };
  }
  return { success: true, data: { yaw: obj.yaw, pitch: obj.pitch } };
}

export function validatePlayerId(id: unknown): ValidationResult<string> {
  if (typeof id !== 'string') {
    return { success: false, error: 'Player ID must be a string' };
  }
  if (id.length < CONFIG.playerIdMinLength || id.length > CONFIG.playerIdMaxLength) {
    return { success: false, error: `Player ID length must be ${CONFIG.playerIdMinLength}-${CONFIG.playerIdMaxLength}` };
  }
  if (!CONFIG.playerIdPattern.test(id)) {
    return { success: false, error: 'Player ID contains invalid characters' };
  }
  return { success: true, data: id };
}

export function validateMessage(raw: unknown): ValidationResult<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) {
    return { success: false, error: 'Message must be an object' };
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (typeof type !== 'string') {
    return { success: false, error: 'Message missing "type" field' };
  }

  switch (type) {
    case 'position': {
      const pos = validateVec3(obj.position);
      if (!pos.success) return { success: false, error: `position: ${pos.error}` };
      const rot = validateRotation(obj.rotation);
      if (!rot.success) return { success: false, error: `rotation: ${rot.error}` };
      const vel = validateVec3(obj.velocity);
      if (!vel.success) return { success: false, error: `velocity: ${vel.error}` };
      // Velocity feeds other clients' dead reckoning — a poisoned magnitude
      // (finite but absurd) would send every observer's extrapolation flying.
      const v = vel.data;
      if (v.x * v.x + v.y * v.y + v.z * v.z > 1000 * 1000) {
        return { success: false, error: 'velocity magnitude out of range' };
      }
      const seq = isFiniteNumber(obj.seq) ? obj.seq : undefined;
      const ping = isFiniteNumber(obj.ping) ? obj.ping : undefined;
      return { success: true, data: { type: 'position', position: pos.data, rotation: rot.data, velocity: vel.data, seq, ping } };
    }

    case 'teleport': {
      const pos = validateVec3(obj.position);
      if (!pos.success) return { success: false, error: `position: ${pos.error}` };
      const rot = validateRotation(obj.rotation);
      if (!rot.success) return { success: false, error: `rotation: ${rot.error}` };
      const vel = validateVec3(obj.velocity);
      if (!vel.success) return { success: false, error: `velocity: ${vel.error}` };
      // Same velocity-magnitude guard as position — a poisoned teleport
      // still feeds observers' dead reckoning
      const v = vel.data;
      if (v.x * v.x + v.y * v.y + v.z * v.z > 1000 * 1000) {
        return { success: false, error: 'velocity magnitude out of range' };
      }
      return { success: true, data: { type: 'teleport', position: pos.data, rotation: rot.data, velocity: vel.data } };
    }

    case 'shot': {
      const targetId = obj.targetId;
      if (targetId !== null && typeof targetId !== 'string') {
        return { success: false, error: 'targetId must be string or null' };
      }
      const position = obj.position !== undefined ? validateVec3(obj.position) : undefined;
      if (position && !position.success) return { success: false, error: `position: ${position.error}` };
      const velocity = obj.velocity !== undefined ? validateVec3(obj.velocity) : undefined;
      if (velocity && !velocity.success) return { success: false, error: `velocity: ${velocity.error}` };
      return {
        success: true,
        data: {
          type: 'shot',
          targetId: targetId as string | null,
          position: position?.success ? position.data : undefined,
          velocity: velocity?.success ? velocity.data : undefined,
          timestamp: isFiniteNumber(obj.timestamp) ? obj.timestamp : undefined,
          projectileId: typeof obj.projectileId === 'string' ? obj.projectileId : undefined,
          weaponType: isFiniteNumber(obj.weaponType) ? obj.weaponType : undefined,
          airtime: isFiniteNumber(obj.airtime) ? obj.airtime : undefined,
        },
      };
    }

    case 'aoeShot': {
      const pos = validateVec3(obj.position);
      if (!pos.success) return { success: false, error: `position: ${pos.error}` };
      const excludeTargetId = obj.excludeTargetId;
      if (excludeTargetId !== null && excludeTargetId !== undefined && typeof excludeTargetId !== 'string') {
        return { success: false, error: 'excludeTargetId must be string or null' };
      }
      return {
        success: true,
        data: {
          type: 'aoeShot',
          position: pos.data,
          weaponType: isFiniteNumber(obj.weaponType) ? obj.weaponType : undefined,
          excludeTargetId: (excludeTargetId as string | null) ?? null,
          projectileId: typeof obj.projectileId === 'string' ? obj.projectileId : undefined,
          airtime: isFiniteNumber(obj.airtime) ? obj.airtime : undefined,
          power: isFiniteNumber(obj.power) ? obj.power : undefined,
          directHit: obj.directHit === true ? true : undefined,
        },
      };
    }

    case 'jump':
    case 'jetpack': {
      const pos = validateVec3(obj.position);
      if (!pos.success) return { success: false, error: `position: ${pos.error}` };
      return { success: true, data: { type, position: pos.data } as ClientMessage };
    }

    case 'inputMove': {
      const input = obj.input;
      if (typeof input !== 'object' || input === null) {
        return { success: false, error: 'input must be an object' };
      }
      const i = input as Record<string, unknown>;
      if (!isFiniteNumber(i.forward) || !isFiniteNumber(i.right) || !isFiniteNumber(i.jump) || !isFiniteNumber(i.ski)) {
        return { success: false, error: 'input fields must be finite numbers' };
      }
      const rot = validateRotation(obj.rotation);
      if (!rot.success) return { success: false, error: `rotation: ${rot.error}` };
      return {
        success: true,
        data: {
          type: 'inputMove',
          input: { forward: i.forward, right: i.right, jump: i.jump, ski: i.ski },
          rotation: rot.data,
        },
      };
    }

    case 'projectileDestroy': {
      if (typeof obj.projectileId !== 'string') {
        return { success: false, error: 'projectileId must be a string' };
      }
      return { success: true, data: { type: 'projectileDestroy', projectileId: obj.projectileId } };
    }

    case 'environmentDamage': {
      if (!isFiniteNumber(obj.amount)) {
        return { success: false, error: 'amount must be a finite number' };
      }
      return { success: true, data: { type: 'environmentDamage', amount: obj.amount } };
    }

    case 'heal': {
      if (!isFiniteNumber(obj.amount)) {
        return { success: false, error: 'amount must be a finite number' };
      }
      return { success: true, data: { type: 'heal', amount: obj.amount } };
    }

    case 'creatureHit': {
      if (!isFiniteNumber(obj.id) || !Number.isInteger(obj.id) || obj.id < 0) {
        return { success: false, error: 'id must be a non-negative integer' };
      }
      if (!isFiniteNumber(obj.damage)) {
        return { success: false, error: 'damage must be a finite number' };
      }
      const kx = isFiniteNumber(obj.kx) ? obj.kx : undefined;
      const ky = isFiniteNumber(obj.ky) ? obj.ky : undefined;
      const kz = isFiniteNumber(obj.kz) ? obj.kz : undefined;
      return { success: true, data: { type: 'creatureHit', id: obj.id, damage: obj.damage, kx, ky, kz } };
    }

    case 'snapshotRequest': {
      return { success: true, data: { type: 'snapshotRequest' } };
    }

    case 'chat': {
      // Relay-only content: length cap is the whole validation — the server
      // never interprets the text, clients render it escaped (textContent).
      if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > 200) {
        return { success: false, error: 'chat text must be 1-200 chars' };
      }
      return { success: true, data: { type: 'chat', text: obj.text } };
    }

    case 'ping': {
      if (!isFiniteNumber(obj.timestamp)) {
        return { success: false, error: 'ping timestamp must be a finite number' };
      }
      return { success: true, data: { type: 'ping', timestamp: obj.timestamp } };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}
