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
      return { success: true, data: { type: 'position', position: pos.data, rotation: rot.data, velocity: vel.data } };
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
        data: { type: 'aoeShot', position: pos.data, excludeTargetId: (excludeTargetId as string | null) ?? null },
      };
    }

    case 'discAOEShot': {
      const pos = validateVec3(obj.position);
      if (!pos.success) return { success: false, error: `position: ${pos.error}` };
      const excludeTargetId = obj.excludeTargetId;
      if (excludeTargetId !== null && excludeTargetId !== undefined && typeof excludeTargetId !== 'string') {
        return { success: false, error: 'excludeTargetId must be string or null' };
      }
      return {
        success: true,
        data: { type: 'discAOEShot', position: pos.data, excludeTargetId: (excludeTargetId as string | null) ?? null },
      };
    }

    case 'grenadeAOEShot': {
      const pos = validateVec3(obj.position);
      if (!pos.success) return { success: false, error: `position: ${pos.error}` };
      const excludeTargetId = obj.excludeTargetId;
      if (excludeTargetId !== null && excludeTargetId !== undefined && typeof excludeTargetId !== 'string') {
        return { success: false, error: 'excludeTargetId must be string or null' };
      }
      return {
        success: true,
        data: { type: 'grenadeAOEShot', position: pos.data, excludeTargetId: (excludeTargetId as string | null) ?? null },
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

    case 'input': {
      return { success: true, data: { type: 'input', input: obj.input } };
    }

    case 'snapshotRequest': {
      return { success: true, data: { type: 'snapshotRequest' } };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}
