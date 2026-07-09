import { DemoFile } from '../types/DemoFile.js';
import { DemoSerializer } from '../serialization/DemoSerializer.js';

/**
 * Shareable demo link data.
 */
export interface ShareableDemoLink {
  /** Demo ID */
  id: string;
  /** Demo name */
  name: string;
  /** Timestamp */
  timestamp: number;
  /** Duration */
  duration: number;
  /** Base64 encoded demo data (compressed) */
  data: string;
  /** Checksum */
  checksum: string;
}

/**
 * Demo sharing utilities.
 * Generates shareable links and handles demo distribution.
 */
export class DemoSharing {
  /**
   * Generate a shareable link for a demo.
   * @param demo - Demo file
   * @param id - Demo ID
   * @param name - Demo name
   * @returns Shareable link data
   */
  static generateShareableLink(demo: DemoFile, id: string, name: string): ShareableDemoLink {
    const data = DemoSerializer.serialize(demo);
    const base64 = DemoSharing.arrayBufferToBase64(data.buffer);
    const checksum = DemoSharing.calculateChecksum(data);

    return {
      id,
      name,
      timestamp: demo.header.timestamp,
      duration: demo.header.duration,
      data: base64,
      checksum,
    };
  }

  /**
   * Create a shareable URL for a demo.
   * @param linkData - Shareable link data
   * @param baseUrl - Base URL for sharing
   * @returns Shareable URL
   */
  static createShareableURL(linkData: ShareableDemoLink, baseUrl: string = ''): string {
    const params = new URLSearchParams();
    params.set('id', linkData.id);
    params.set('name', linkData.name);
    params.set('t', linkData.timestamp.toString());
    params.set('d', linkData.duration.toString());
    params.set('data', linkData.data);
    params.set('checksum', linkData.checksum);

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Parse a shareable URL.
   * @param url - Shareable URL
   * @returns Shareable link data or null
   */
  static parseShareableURL(url: string): ShareableDemoLink | null {
    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;

      const id = params.get('id');
      const name = params.get('name');
      const t = params.get('t');
      const d = params.get('d');
      const data = params.get('data');
      const checksum = params.get('checksum');

      if (!id || !name || !t || !d || !data || !checksum) {
        return null;
      }

      return {
        id,
        name,
        timestamp: parseInt(t, 10),
        duration: parseFloat(d),
        data,
        checksum,
      };
    } catch (e) {
      console.error('[DemoSharing] Failed to parse shareable URL:', e);
      return null;
    }
  }

  /**
   * Load a demo from shareable link data.
   * @param linkData - Shareable link data
   * @returns Demo file
   */
  static loadFromShareableLink(linkData: ShareableDemoLink): DemoFile {
    const buffer = DemoSharing.base64ToArrayBuffer(linkData.data);
    const data = new Uint8Array(buffer.slice(0));

    // Verify checksum
    const calculatedChecksum = DemoSharing.calculateChecksum(data);
    if (calculatedChecksum !== linkData.checksum) {
      console.warn('[DemoSharing] Checksum mismatch, data may be corrupted');
    }

    return DemoSerializer.deserialize(data);
  }

  /**
   * Calculate checksum for demo data.
   * @param data - Demo data
   * @returns Checksum string
   */
  private static calculateChecksum(data: Uint8Array): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Convert ArrayBuffer to Base64.
   * @param buffer - ArrayBuffer
   * @returns Base64 string
   */
  private static arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 to ArrayBuffer.
   * @param base64 - Base64 string
   * @returns ArrayBuffer
   */
  private static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Check if a demo is too large to share via URL.
   * @param demo - Demo file
   * @param maxSize - Maximum size in bytes (default: 1MB)
   * @returns True if too large
   */
  static isTooLargeForURL(demo: DemoFile, maxSize: number = 1024 * 1024): boolean {
    const data = DemoSerializer.serialize(demo);
    return data.length > maxSize;
  }

  /**
   * Generate a short share code for a demo.
   * @param demo - Demo file
   * @returns Short code
   */
  static generateShortCode(demo: DemoFile): string {
    const data = DemoSerializer.serialize(demo);
    const hash = DemoSharing.calculateChecksum(data);
    return hash.substring(0, 8).toUpperCase();
  }
}
