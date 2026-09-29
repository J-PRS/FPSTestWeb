import { CONFIG } from './config.ts';
import { isPerkId } from '../../shared/perks.ts';
import type { ClientMessage, Vec3, Rotation } from './types.ts';

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

// Room/map/mode name grammar — shared by the join handshake and switchRoom.
const word = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[\w-]{1,32}$/.test(v) ? v : undefined;

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

// Movement body shared by position + teleport — velocity feeds other
// clients' dead reckoning, so a finite-but-absurd magnitude is poisoned.
function validateBody(obj: Record<string, unknown>): ValidationResult<{ position: Vec3; rotation: Rotation; velocity: Vec3 }> {
  const pos = validateVec3(obj.position);
  if (!pos.success) return { success: false, error: `position: ${pos.error}` };
  const rot = validateRotation(obj.rotation);
  if (!rot.success) return { success: false, error: `rotation: ${rot.error}` };
  const vel = validateVec3(obj.velocity);
  if (!vel.success) return { success: false, error: `velocity: ${vel.error}` };
  const v = vel.data;
  if (v.x * v.x + v.y * v.y + v.z * v.z > 1000 * 1000) {
    return { success: false, error: 'velocity magnitude out of range' };
  }
  // Position is judge-mode truth — an unbounded coordinate becomes
  // broadcast state and poisons lag-comp history, not just a reject.
  const p = pos.data;
  if (p.x * p.x + p.y * p.y + p.z * p.z > 8192 * 8192) {
    return { success: false, error: 'position magnitude out of range' };
  }
  return { success: true, data: { position: pos.data, rotation: rot.data, velocity: vel.data } };
}

// Optional vec — absent is fine, present-but-bad is not.
type OptVec = { ok: true; data?: Vec3 } | { ok: false; error: string };
function optVec(value: unknown): OptVec {
  if (value === undefined) return { ok: true };
  const r = validateVec3(value);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

// Per-type validators — a new message type is one table entry, not a
// switch case in an 80-branch wall.
const VALIDATORS: Record<string, (obj: Record<string, unknown>) => ValidationResult<ClientMessage>> = {
  position: (obj) => {
    const body = validateBody(obj);
    if (!body.success) return body;
    const seq = isFiniteNumber(obj.seq) ? obj.seq : undefined;
    const inputSeq = isFiniteNumber(obj.inputSeq) ? obj.inputSeq : undefined;
    const ping = isFiniteNumber(obj.ping) ? obj.ping : undefined;
    return { success: true, data: { type: 'position', ...body.data, seq, inputSeq, ping } };
  },

  teleport: (obj) => {
    const body = validateBody(obj);
    if (!body.success) return body;
    return { success: true, data: { type: 'teleport', ...body.data } };
  },

  shot: (obj) => {
    const targetId = obj.targetId;
    if (targetId !== null && typeof targetId !== 'string') {
      return { success: false, error: 'targetId must be string or null' };
    }
    const position = optVec(obj.position);
    if (!position.ok) return { success: false, error: `position: ${position.error}` };
    const velocity = optVec(obj.velocity);
    if (!velocity.ok) return { success: false, error: `velocity: ${velocity.error}` };
    return {
      success: true,
      data: {
        type: 'shot',
        targetId: targetId as string | null,
        position: position.ok ? position.data : undefined,
        velocity: velocity.ok ? velocity.data : undefined,
        timestamp: isFiniteNumber(obj.timestamp) ? obj.timestamp : undefined,
        projectileId: typeof obj.projectileId === 'string' ? obj.projectileId : undefined,
        weaponType: isFiniteNumber(obj.weaponType) ? obj.weaponType : undefined,
        airtime: isFiniteNumber(obj.airtime) ? obj.airtime : undefined,
      },
    };
  },

  aoeShot: (obj) => {
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
  },

  shotFired: (obj) => {
    const dir = optVec(obj.dir);
    if (!dir.ok) return { success: false, error: `dir: ${dir.error}` };
    return {
      success: true,
      data: {
        type: 'shotFired',
        weaponType: isFiniteNumber(obj.weaponType) ? obj.weaponType : undefined,
        dir: dir.ok ? dir.data : undefined,
      },
    };
  },

  jump: (obj) => {
    const pos = validateVec3(obj.position);
    if (!pos.success) return { success: false, error: `position: ${pos.error}` };
    return { success: true, data: { type: 'jump', position: pos.data } };
  },

  jetpack: (obj) => {
    const pos = validateVec3(obj.position);
    if (!pos.success) return { success: false, error: `position: ${pos.error}` };
    return { success: true, data: { type: 'jetpack', position: pos.data } };
  },

  inputMove: (obj) => {
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
        seq: isFiniteNumber(obj.seq) ? obj.seq : undefined,
        input: { forward: i.forward, right: i.right, jump: i.jump, ski: i.ski, jet: isFiniteNumber(i.jet) ? i.jet : 0, status: isFiniteNumber(i.status) ? i.status : 0 },
        rotation: rot.data,
      },
    };
  },

  projectileDestroy: (obj) => {
    if (typeof obj.projectileId !== 'string') {
      return { success: false, error: 'projectileId must be a string' };
    }
    return { success: true, data: { type: 'projectileDestroy', projectileId: obj.projectileId } };
  },

  environmentDamage: (obj) => {
    if (!isFiniteNumber(obj.amount)) {
      return { success: false, error: 'amount must be a finite number' };
    }
    return { success: true, data: { type: 'environmentDamage', amount: obj.amount } };
  },

  heal: (obj) => {
    if (!isFiniteNumber(obj.amount)) {
      return { success: false, error: 'amount must be a finite number' };
    }
    return { success: true, data: { type: 'heal', amount: obj.amount } };
  },

  creatureHit: (obj) => {
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
  },

  deploy: (obj) => {
    const kind = obj.kind;
    if (kind !== 'turret' && kind !== 'mine' && kind !== 'station' && kind !== 'drone') {
      return { success: false, error: 'kind must be turret|mine|station|drone' };
    }
    const dpos = validateVec3(obj.position);
    if (!dpos.success) return { success: false, error: `position: ${dpos.error}` };
    return { success: true, data: { type: 'deploy', kind, position: dpos.data } };
  },

  snapshotRequest: () => {
    return { success: true, data: { type: 'snapshotRequest' } };
  },

  classUpdate: (obj) => {
    const c = obj.armorClass;
    if (c !== 'light' && c !== 'medium' && c !== 'heavy') {
      return { success: false, error: 'armorClass must be light|medium|heavy' };
    }
    return { success: true, data: { type: 'classUpdate', armorClass: c } };
  },

  perkUpdate: (obj) => {
    if (!isPerkId(obj.perk)) {
      return { success: false, error: 'perk must be a known PerkId' };
    }
    return { success: true, data: { type: 'perkUpdate', perk: obj.perk } };
  },

  // Same name/map/mode grammar as the join handshake — a bad name just
  // lands you in 'default', never a rejection.
  switchRoom: (obj) => {
    const bots = isFiniteNumber(obj.bots)
      ? Math.max(0, Math.min(24, Math.floor(obj.bots as number)))
      : undefined;
    return { success: true, data: { type: 'switchRoom', room: word(obj.room), map: word(obj.map), mode: word(obj.mode), bots } };
  },

  // Relay-only content: length cap is the whole validation — the server
  // never interprets the text, clients render it escaped (textContent).
  chat: (obj) => {
    if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > 200) {
      return { success: false, error: 'chat text must be 1-200 chars' };
    }
    return { success: true, data: { type: 'chat', text: obj.text } };
  },

  ping: (obj) => {
    if (!isFiniteNumber(obj.timestamp)) {
      return { success: false, error: 'ping timestamp must be a finite number' };
    }
    return { success: true, data: { type: 'ping', timestamp: obj.timestamp } };
  },
};

export function validateMessage(raw: unknown): ValidationResult<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) {
    return { success: false, error: 'Message must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string') {
    return { success: false, error: 'Message missing "type" field' };
  }
  const validator = VALIDATORS[type];
  if (!validator) {
    return { success: false, error: `Unknown message type: ${type}` };
  }
  return validator(obj);
}
