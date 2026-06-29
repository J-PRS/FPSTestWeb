/**
 * Encryption utilities for demo files.
 * Uses Web Crypto API for secure encryption.
 */
export class DemoEncryption {
  /**
   * Generate a random encryption key.
   * @returns Encryption key
   */
  static async generateKey(): Promise<CryptoKey> {
    return await crypto.subtle.generateKey(
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Export key to base64 string.
   * @param key - Crypto key
   * @returns Base64 encoded key
   */
  static async exportKey(key: CryptoKey): Promise<string> {
    const exported = await crypto.subtle.exportKey('raw', key);
    const base64 = DemoEncryption.arrayBufferToBase64(exported);
    return base64;
  }

  /**
   * Import key from base64 string.
   * @param base64 - Base64 encoded key
   * @returns Crypto key
   */
  static async importKey(base64: string): Promise<CryptoKey> {
    const buffer = DemoEncryption.base64ToArrayBuffer(base64);
    return await crypto.subtle.importKey(
      'raw',
      buffer,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt demo data.
   * @param data - Demo data (Uint8Array)
   * @param key - Encryption key
   * @returns Encrypted data
   */
  static async encrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      key,
      data.buffer.slice(0) as ArrayBuffer
    );

    // Combine IV and encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);

    return result;
  }

  /**
   * Decrypt demo data.
   * @param data - Encrypted data
   * @param key - Decryption key
   * @returns Decrypted data
   */
  static async decrypt(data: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      key,
      encrypted
    );

    return new Uint8Array(decrypted);
  }

  /**
   * Generate a key from password.
   * @param password - Password string
   * @param salt - Salt (optional, will generate if not provided)
   * @returns Object with key and salt
   */
  static async deriveKeyFromPassword(
    password: string,
    salt?: Uint8Array
  ): Promise<{ key: CryptoKey; salt: Uint8Array }> {
    const encoder = new TextEncoder();
    const passwordData = encoder.encode(password);

    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16));
    }

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordData.buffer.slice(0) as ArrayBuffer,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt.buffer.slice(0) as ArrayBuffer,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );

    return { key, salt };
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
}
