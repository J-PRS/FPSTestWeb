import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';
import { DemoHeader } from '../types/DemoHeader.js';
import { ProjectileEventType } from '../types/ProjectileEvent.js';
import { TargetEventType } from '../types/TargetEvent.js';
import { CRC32 } from './CRC32.js';

/**
 * Binary serializer for demo files.
 * Uses efficient binary encoding for minimal file size.
 * Little-endian byte order for consistency.
 */
export class DemoSerializer {
  private static readonly MAGIC_NUMBER = 0x44; // 'D'
  private static readonly HEADER_SIZE = 64;

  /**
   * Serialize a DemoFile to a byte array.
   */
  static serialize(demo: DemoFile): Uint8Array {
    // Calculate total size
    const headerSize = DemoSerializer.HEADER_SIZE;
    const initialStateSize = 12 + 16 + 12; // position + rotation + velocity
    const framesSize = demo.frames.length * 32;
    const projectileEventsSize = demo.projectileEvents.length * 48;
    const targetEventsSize = demo.targetEvents.length * 40;
    const totalSize = headerSize + initialStateSize + framesSize + projectileEventsSize + targetEventsSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Write header (without checksum first)
    offset = DemoSerializer.writeHeader(view, offset, demo.header);

    // Write initial state
    offset = DemoSerializer.writeVector3(view, offset, demo.playerStartPosition);
    offset = DemoSerializer.writeQuaternion(view, offset, demo.playerStartRotation);
    offset = DemoSerializer.writeVector3(view, offset, demo.playerStartVelocity);

    // Write frames
    view.setUint16(offset, demo.frames.length, true);
    offset += 2;
    for (const frame of demo.frames) {
      offset = DemoSerializer.writeFrame(view, offset, frame);
    }

    // Write projectile events
    view.setUint16(offset, demo.projectileEvents.length, true);
    offset += 2;
    for (const event of demo.projectileEvents) {
      offset = DemoSerializer.writeProjectileEvent(view, offset, event);
    }

    // Write target events
    view.setUint16(offset, demo.targetEvents.length, true);
    offset += 2;
    for (const event of demo.targetEvents) {
      offset = DemoSerializer.writeTargetEvent(view, offset, event);
    }

    // Calculate and write checksum
    const data = new Uint8Array(buffer);
    const checksum = CRC32.calculate(data);
    view.setUint32(60, checksum, true); // Checksum is at offset 60 in header

    return data;
  }

  /**
   * Deserialize a byte array to a DemoFile.
   */
  static deserialize(data: Uint8Array): DemoFile {
    const view = new DataView(data.buffer);
    let offset = 0;

    // Read header
    const header = DemoSerializer.readHeader(view, offset);

    // Verify checksum
    const calculatedChecksum = CRC32.calculate(data);
    if (header.checksum !== 0 && header.checksum !== calculatedChecksum) {
      console.warn(
        `[DemoSerializer] Checksum mismatch: expected ${header.checksum}, calculated ${calculatedChecksum}`
      );
    }

    offset += DemoSerializer.HEADER_SIZE;

    // Read initial state
    const playerStartPosition = DemoSerializer.readVector3(view, offset);
    offset += 12;
    const playerStartRotation = DemoSerializer.readQuaternion(view, offset);
    offset += 16;
    const playerStartVelocity = DemoSerializer.readVector3(view, offset);
    offset += 12;

    // Read frames
    const frameCount = view.getUint16(offset, true);
    offset += 2;
    const frames: DemoFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      frames.push(DemoSerializer.readFrame(view, offset));
      offset += 32;
    }

    // Read projectile events
    const projectileEventCount = view.getUint16(offset, true);
    offset += 2;
    const projectileEvents: ProjectileEvent[] = [];
    for (let i = 0; i < projectileEventCount; i++) {
      projectileEvents.push(DemoSerializer.readProjectileEvent(view, offset));
      offset += 48;
    }

    // Read target events
    const targetEventCount = view.getUint16(offset, true);
    offset += 2;
    const targetEvents: TargetEvent[] = [];
    for (let i = 0; i < targetEventCount; i++) {
      targetEvents.push(DemoSerializer.readTargetEvent(view, offset));
      offset += 40;
    }

    return {
      header,
      frames,
      projectileEvents,
      targetEvents,
      playerStartPosition,
      playerStartRotation,
      playerStartVelocity,
    };
  }

  /**
   * Write header to DataView.
   * @param writeChecksum - Whether to write checksum (false if calculating later)
   */
  private static writeHeader(view: DataView, offset: number, header: DemoHeader, writeChecksum: boolean = true): number {
    view.setUint8(offset, DemoSerializer.MAGIC_NUMBER);
    offset += 1;

    view.setInt32(offset, header.formatVersion, true);
    offset += 4;

    const gameVersionBytes = new TextEncoder().encode(header.gameVersion);
    view.setUint8(offset, gameVersionBytes.length);
    offset += 1;
    for (let i = 0; i < gameVersionBytes.length; i++) {
      view.setUint8(offset + i, gameVersionBytes[i]);
    }
    offset += gameVersionBytes.length;

    view.setFloat32(offset, header.duration, true);
    offset += 4;

    view.setUint32(offset, header.totalFrames, true);
    offset += 4;

    view.setUint32(offset, header.projectileEvents, true);
    offset += 4;

    view.setUint32(offset, header.targetEvents, true);
    offset += 4;

    offset = DemoSerializer.writeVector3(view, offset, header.playerStartPosition);
    offset = DemoSerializer.writeQuaternion(view, offset, header.playerStartRotation);
    offset = DemoSerializer.writeVector3(view, offset, header.playerStartVelocity);

    const descriptionBytes = new TextEncoder().encode(header.description);
    view.setUint8(offset, descriptionBytes.length);
    offset += 1;
    for (let i = 0; i < descriptionBytes.length; i++) {
      view.setUint8(offset + i, descriptionBytes[i]);
    }
    offset += descriptionBytes.length;

    if (writeChecksum) {
      view.setUint32(offset, header.checksum, true);
    } else {
      view.setUint32(offset, 0, true); // Placeholder
    }
    offset += 4;

    view.setUint32(offset, Math.floor(header.timestamp / 1000), true);
    offset += 4;

    // Pad to 64 bytes
    while (offset < DemoSerializer.HEADER_SIZE) {
      view.setUint8(offset, 0);
      offset += 1;
    }

    return offset;
  }

  /**
   * Read header from DataView.
   */
  private static readHeader(view: DataView, offset: number): DemoHeader {
    const magic = view.getUint8(offset);
    if (magic !== DemoSerializer.MAGIC_NUMBER) {
      throw new Error(`Invalid magic number: ${magic}`);
    }
    offset += 1;

    const formatVersion = view.getInt32(offset, true);
    offset += 4;

    const gameVersionLength = view.getUint8(offset);
    offset += 1;
    const gameVersionBytes = new Uint8Array(gameVersionLength);
    for (let i = 0; i < gameVersionLength; i++) {
      gameVersionBytes[i] = view.getUint8(offset + i);
    }
    offset += gameVersionLength;
    const gameVersion = new TextDecoder().decode(gameVersionBytes);

    const duration = view.getFloat32(offset, true);
    offset += 4;

    const totalFrames = view.getUint32(offset, true);
    offset += 4;

    const projectileEvents = view.getUint32(offset, true);
    offset += 4;

    const targetEvents = view.getUint32(offset, true);
    offset += 4;

    const playerStartPosition = DemoSerializer.readVector3(view, offset);
    offset += 12;
    const playerStartRotation = DemoSerializer.readQuaternion(view, offset);
    offset += 16;
    const playerStartVelocity = DemoSerializer.readVector3(view, offset);
    offset += 12;

    const descriptionLength = view.getUint8(offset);
    offset += 1;
    const descriptionBytes = new Uint8Array(descriptionLength);
    for (let i = 0; i < descriptionLength; i++) {
      descriptionBytes[i] = view.getUint8(offset + i);
    }
    offset += descriptionLength;
    const description = new TextDecoder().decode(descriptionBytes);

    const checksum = view.getUint32(offset, true);
    offset += 4;

    const timestamp = view.getUint32(offset, true) * 1000;
    offset += 4;

    return {
      formatVersion,
      gameVersion,
      duration,
      totalFrames,
      projectileEvents,
      targetEvents,
      playerStartPosition,
      playerStartRotation,
      playerStartVelocity,
      description,
      checksum,
      timestamp,
    };
  }

  /**
   * Write a DemoFrame to DataView.
   */
  private static writeFrame(view: DataView, offset: number, frame: DemoFrame): number {
    view.setUint16(offset, frame.frameNumber, true);
    offset += 2;

    view.setFloat32(offset, frame.timestamp, true);
    offset += 4;

    offset = DemoSerializer.writeVector3(view, offset, frame.position);
    offset = DemoSerializer.writeVector3(view, offset, frame.velocity);
    offset = DemoSerializer.writeQuaternion(view, offset, frame.rotation);

    view.setUint8(offset, frame.inputFlags);
    offset += 1;

    view.setInt16(offset, frame.mouseDeltaX, true);
    offset += 2;

    view.setInt16(offset, frame.mouseDeltaY, true);
    offset += 2;

    view.setUint8(offset, frame.jetpackFlags);
    offset += 1;

    view.setFloat32(offset, frame.jetpackFuel, true);
    offset += 4;

    return offset;
  }

  /**
   * Read a DemoFrame from DataView.
   */
  private static readFrame(view: DataView, offset: number): DemoFrame {
    const frameNumber = view.getUint16(offset, true);
    offset += 2;

    const timestamp = view.getFloat32(offset, true);
    offset += 4;

    const position = DemoSerializer.readVector3(view, offset);
    offset += 12;
    const velocity = DemoSerializer.readVector3(view, offset);
    offset += 12;
    const rotation = DemoSerializer.readQuaternion(view, offset);
    offset += 16;

    const inputFlags = view.getUint8(offset);
    offset += 1;

    const mouseDeltaX = view.getInt16(offset, true);
    offset += 2;

    const mouseDeltaY = view.getInt16(offset, true);
    offset += 2;

    const jetpackFlags = view.getUint8(offset);
    offset += 1;

    const jetpackFuel = view.getFloat32(offset, true);
    offset += 4;

    return {
      frameNumber,
      timestamp,
      position,
      velocity,
      rotation,
      inputFlags,
      mouseDeltaX,
      mouseDeltaY,
      jetpackFlags,
      jetpackFuel,
    };
  }

  /**
   * Write a ProjectileEvent to DataView.
   */
  private static writeProjectileEvent(view: DataView, offset: number, event: ProjectileEvent): number {
    view.setUint8(offset, event.eventType);
    offset += 1;

    view.setFloat32(offset, event.timestamp, true);
    offset += 4;

    offset = DemoSerializer.writeVector3(view, offset, event.position);
    offset = DemoSerializer.writeVector3(view, offset, event.velocity);

    view.setUint16(offset, event.projectileId, true);
    offset += 2;

    view.setUint8(offset, event.weaponType);
    offset += 1;

    offset = DemoSerializer.writeVector3(view, offset, event.surfaceNormal);

    view.setUint16(offset, event.targetId, true);
    offset += 2;

    view.setUint8(offset, event.hasPeakPosition ? 1 : 0);
    offset += 1;

    offset = DemoSerializer.writeVector3(view, offset, event.peakPosition);

    return offset;
  }

  /**
   * Read a ProjectileEvent from DataView.
   */
  private static readProjectileEvent(view: DataView, offset: number): ProjectileEvent {
    const eventType = view.getUint8(offset);
    offset += 1;

    const timestamp = view.getFloat32(offset, true);
    offset += 4;

    const position = DemoSerializer.readVector3(view, offset);
    offset += 12;
    const velocity = DemoSerializer.readVector3(view, offset);
    offset += 12;

    const projectileId = view.getUint16(offset, true);
    offset += 2;

    const weaponType = view.getUint8(offset);
    offset += 1;

    const surfaceNormal = DemoSerializer.readVector3(view, offset);
    offset += 12;

    const targetId = view.getUint16(offset, true);
    offset += 2;

    const hasPeakPosition = view.getUint8(offset) === 1;
    offset += 1;

    const peakPosition = DemoSerializer.readVector3(view, offset);
    offset += 12;

    return {
      eventType: eventType as ProjectileEventType,
      timestamp,
      position,
      velocity,
      projectileId,
      weaponType,
      surfaceNormal,
      targetId,
      hasPeakPosition,
      peakPosition,
    };
  }

  /**
   * Write a TargetEvent to DataView.
   */
  private static writeTargetEvent(view: DataView, offset: number, event: TargetEvent): number {
    view.setUint8(offset, event.eventType);
    offset += 1;

    view.setFloat32(offset, event.timestamp, true);
    offset += 4;

    offset = DemoSerializer.writeVector3(view, offset, event.position);
    offset = DemoSerializer.writeVector3(view, offset, event.velocity);

    view.setUint16(offset, event.targetId, true);
    offset += 2;

    view.setUint8(offset, event.targetType);
    offset += 1;

    view.setFloat32(offset, event.health, true);
    offset += 4;

    view.setUint8(offset, event.hasPeakPosition ? 1 : 0);
    offset += 1;

    offset = DemoSerializer.writeVector3(view, offset, event.peakPosition);

    return offset;
  }

  /**
   * Read a TargetEvent from DataView.
   */
  private static readTargetEvent(view: DataView, offset: number): TargetEvent {
    const eventType = view.getUint8(offset);
    offset += 1;

    const timestamp = view.getFloat32(offset, true);
    offset += 4;

    const position = DemoSerializer.readVector3(view, offset);
    offset += 12;
    const velocity = DemoSerializer.readVector3(view, offset);
    offset += 12;

    const targetId = view.getUint16(offset, true);
    offset += 2;

    const targetType = view.getUint8(offset);
    offset += 1;

    const health = view.getFloat32(offset, true);
    offset += 4;

    const hasPeakPosition = view.getUint8(offset) === 1;
    offset += 1;

    const peakPosition = DemoSerializer.readVector3(view, offset);
    offset += 12;

    return {
      eventType: eventType as TargetEventType,
      timestamp,
      position,
      velocity,
      targetId,
      targetType,
      health,
      hasPeakPosition,
      peakPosition,
    };
  }

  /**
   * Write a Vector3 to DataView.
   */
  private static writeVector3(view: DataView, offset: number, v: THREE.Vector3): number {
    view.setFloat32(offset, v.x, true);
    view.setFloat32(offset + 4, v.y, true);
    view.setFloat32(offset + 8, v.z, true);
    return offset + 12;
  }

  /**
   * Read a Vector3 from DataView.
   */
  private static readVector3(view: DataView, offset: number): THREE.Vector3 {
    return new THREE.Vector3(
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true)
    );
  }

  /**
   * Write a Quaternion to DataView.
   */
  private static writeQuaternion(view: DataView, offset: number, q: THREE.Quaternion): number {
    view.setFloat32(offset, q.x, true);
    view.setFloat32(offset + 4, q.y, true);
    view.setFloat32(offset + 8, q.z, true);
    view.setFloat32(offset + 12, q.w, true);
    return offset + 16;
  }

  /**
   * Read a Quaternion from DataView.
   */
  private static readQuaternion(view: DataView, offset: number): THREE.Quaternion {
    return new THREE.Quaternion(
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
      view.getFloat32(offset + 12, true)
    );
  }

  /**
   * Save a DemoFile to a file (browser environment).
   * @param demo - DemoFile to save
   * @param filename - Output filename
   */
  static async saveToFile(demo: DemoFile, filename: string): Promise<void> {
    const data = DemoSerializer.serialize(demo);
    const arrayBuffer = data.buffer.slice(0) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Load a DemoFile from a file (browser environment).
   * @param file - File to load
   */
  static async loadFromFile(file: File): Promise<DemoFile> {
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    return DemoSerializer.deserialize(data);
  }

  /**
   * Estimate the file size for a DemoFile.
   */
  static estimateFileSize(demo: DemoFile): number {
    return (
      DemoSerializer.HEADER_SIZE +
      40 + // initial state
      demo.frames.length * 32 +
      demo.projectileEvents.length * 48 +
      demo.targetEvents.length * 40
    );
  }
}
