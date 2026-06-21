/**
 * Binary Protocol for efficient network communication
 * Reduces bandwidth by 50-70% compared to JSON
 */

// Message types (1 byte)
export enum MessageType {
  JOIN = 0,
  INPUT = 1,
  POSITION = 2,
  SHOT = 3,
  PLAYER_JOINED = 4,
  PLAYER_LEFT = 5,
  PLAYER_UPDATE = 6,
  GAME_STATE = 7,
  HIT = 8,
  KILL = 9,
  PLAYER_RESPAWN = 10
}

// Binary encoder
export class BinaryEncoder {
  private buffer: Uint8Array;
  private offset: number = 0;

  constructor(initialSize: number = 256) {
    this.buffer = new Uint8Array(initialSize);
  }

  private ensureCapacity(size: number): void {
    if (this.offset + size > this.buffer.length) {
      const newBuffer = new Uint8Array(this.buffer.length * 2);
      newBuffer.set(this.buffer);
      this.buffer = newBuffer;
    }
  }

  writeUint8(value: number): void {
    this.ensureCapacity(1);
    this.buffer[this.offset++] = value;
  }

  writeUint16(value: number): void {
    this.ensureCapacity(2);
    this.buffer[this.offset++] = value & 0xff;
    this.buffer[this.offset++] = (value >> 8) & 0xff;
  }

  writeUint32(value: number): void {
    this.ensureCapacity(4);
    this.buffer[this.offset++] = value & 0xff;
    this.buffer[this.offset++] = (value >> 8) & 0xff;
    this.buffer[this.offset++] = (value >> 16) & 0xff;
    this.buffer[this.offset++] = (value >> 24) & 0xff;
  }

  writeFloat32(value: number): void {
    this.ensureCapacity(4);
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 4);
    view.setFloat32(0, value, true); // little-endian
    this.offset += 4;
  }

  writeFloat64(value: number): void {
    this.ensureCapacity(8);
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 8);
    view.setFloat64(0, value, true); // little-endian
    this.offset += 8;
  }

  writeString(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.writeUint16(bytes.length);
    this.ensureCapacity(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  writeBytes(bytes: Uint8Array): void {
    this.writeUint16(bytes.length);
    this.ensureCapacity(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  getResult(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }

  reset(): void {
    this.offset = 0;
  }
}

// Binary decoder
export class BinaryDecoder {
  private buffer: Uint8Array;
  private offset: number = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  readUint8(): number {
    if (this.offset >= this.buffer.length) throw new Error('Buffer overflow');
    return this.buffer[this.offset++];
  }

  readUint16(): number {
    if (this.offset + 2 > this.buffer.length) throw new Error('Buffer overflow');
    const value = this.buffer[this.offset] | (this.buffer[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    if (this.offset + 4 > this.buffer.length) throw new Error('Buffer overflow');
    const value = this.buffer[this.offset] |
                  (this.buffer[this.offset + 1] << 8) |
                  (this.buffer[this.offset + 2] << 16) |
                  (this.buffer[this.offset + 3] << 24);
    this.offset += 4;
    return value;
  }

  readFloat32(): number {
    if (this.offset + 4 > this.buffer.length) throw new Error('Buffer overflow');
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 4);
    const value = view.getFloat32(0, true); // little-endian
    this.offset += 4;
    return value;
  }

  readFloat64(): number {
    if (this.offset + 8 > this.buffer.length) throw new Error('Buffer overflow');
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 8);
    const value = view.getFloat64(0, true); // little-endian
    this.offset += 8;
    return value;
  }

  readString(): string {
    const length = this.readUint16();
    if (this.offset + length > this.buffer.length) throw new Error('Buffer overflow');
    const bytes = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(bytes);
  }

  readBytes(): Uint8Array {
    const length = this.readUint16();
    if (this.offset + length > this.buffer.length) throw new Error('Buffer overflow');
    const bytes = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  getRemaining(): number {
    return this.buffer.length - this.offset;
  }
}

// Protocol-specific encoding functions
export function encodePosition(
  playerId: string,
  position: { x: number; y: number; z: number },
  rotation: { yaw: number; pitch: number },
  timestamp: number
): Uint8Array {
  const encoder = new BinaryEncoder();
  encoder.writeUint8(MessageType.POSITION);
  encoder.writeString(playerId);
  encoder.writeFloat32(position.x);
  encoder.writeFloat32(position.y);
  encoder.writeFloat32(position.z);
  encoder.writeFloat32(rotation.yaw);
  encoder.writeFloat32(rotation.pitch);
  encoder.writeUint32(timestamp);
  return encoder.getResult();
}

export function encodeInput(
  playerId: string,
  sequenceNumber: number,
  timestamp: number
): Uint8Array {
  const encoder = new BinaryEncoder();
  encoder.writeUint8(MessageType.INPUT);
  encoder.writeString(playerId);
  encoder.writeUint32(sequenceNumber);
  encoder.writeUint32(timestamp);
  return encoder.getResult();
}

export function encodeShot(
  playerId: string,
  targetId: string | null,
  timestamp: number,
  position?: { x: number; y: number; z: number },
  velocity?: { x: number; y: number; z: number },
  projectileId?: string | null
): Uint8Array {
  const encoder = new BinaryEncoder();
  encoder.writeUint8(MessageType.SHOT);
  encoder.writeString(playerId);
  if (targetId) {
    encoder.writeUint8(1); // has target
    encoder.writeString(targetId);
  } else {
    encoder.writeUint8(0); // no target
  }
  encoder.writeFloat64(timestamp);
  
  // Optional position/velocity for server-side projectile tracking
  if (position && velocity) {
    encoder.writeUint8(1); // has position/velocity
    encoder.writeFloat32(position.x);
    encoder.writeFloat32(position.y);
    encoder.writeFloat32(position.z);
    encoder.writeFloat32(velocity.x);
    encoder.writeFloat32(velocity.y);
    encoder.writeFloat32(velocity.z);
  } else {
    encoder.writeUint8(0); // no position/velocity
  }
  
  // Optional projectileId for destroying projectile on hit
  if (projectileId) {
    encoder.writeUint8(1); // has projectileId
    encoder.writeString(projectileId);
  } else {
    encoder.writeUint8(0); // no projectileId
  }
  
  return encoder.getResult();
}

export function decodePosition(data: Uint8Array): any {
  const decoder = new BinaryDecoder(data);
  const type = decoder.readUint8();
  if (type !== MessageType.POSITION) throw new Error('Invalid message type');
  
  return {
    type: 'position',
    playerId: decoder.readString(),
    data: {
      position: {
        x: decoder.readFloat32(),
        y: decoder.readFloat32(),
        z: decoder.readFloat32()
      },
      rotation: {
        yaw: decoder.readFloat32(),
        pitch: decoder.readFloat32()
      },
      timestamp: decoder.readUint32()
    }
  };
}

export function decodeInput(data: Uint8Array): any {
  const decoder = new BinaryDecoder(data);
  const type = decoder.readUint8();
  if (type !== MessageType.INPUT) throw new Error('Invalid message type');
  
  return {
    type: 'input',
    playerId: decoder.readString(),
    data: {
      sequenceNumber: decoder.readUint32(),
      timestamp: decoder.readUint32()
    }
  };
}

export function decodeShot(data: Uint8Array): any {
  const decoder = new BinaryDecoder(data);
  const type = decoder.readUint8();
  if (type !== MessageType.SHOT) throw new Error('Invalid message type');
  
  const playerId = decoder.readString();
  const hasTarget = decoder.readUint8() === 1;
  const targetId = hasTarget ? decoder.readString() : null;
  const timestamp = decoder.readUint32();
  
  return {
    type: 'shot',
    playerId,
    data: { targetId, timestamp }
  };
}
