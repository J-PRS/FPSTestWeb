import { INetworkAdapter } from './INetworkAdapter.js';
import { WSAdapter } from './WSAdapter.js';
import { UWSAdapter } from './UWSAdapter.js';
import { Tribes2Adapter } from './Tribes2Adapter.js';
import { ChildLogger } from '../Logger.js';

const logger = new ChildLogger('NetworkAdapterFactory');

/**
 * Supported networking backend types
 * 'tribes2' is the recommended backend with bit-packing and state masks for LAN-like gameplay
 */
export type NetworkBackend = 'ws' | 'uws' | 'tribes2';

/**
 * Factory for creating network adapters
 * Allows easy swapping between different networking backends
 */
export class NetworkAdapterFactory {
  /**
   * Create a network adapter based on the specified backend type
   * 
   * @param backend - The networking backend to use ('ws', 'uws', or 'tribes2')
   * @returns An instance of INetworkAdapter
   * @throws Error if the backend type is unsupported
   */
  static createAdapter(backend: NetworkBackend): INetworkAdapter {
    logger.info(`Creating network adapter for backend: ${backend}`);

    switch (backend) {
      case 'ws':
        return new WSAdapter();
      
      case 'uws':
        return new UWSAdapter();
      
      case 'tribes2':
        logger.info('Using Tribes2-style networking with bit-packing and state masks');
        return new Tribes2Adapter();
      
      default:
        const unsupported: never = backend;
        throw new Error(`Unsupported network backend: ${unsupported}`);
    }
  }

  /**
   * Get a list of supported backend types
   */
  static getSupportedBackends(): NetworkBackend[] {
    return ['ws', 'uws', 'tribes2'];
  }

  /**
   * Check if a backend type is supported
   */
  static isBackendSupported(backend: string): backend is NetworkBackend {
    return this.getSupportedBackends().includes(backend as NetworkBackend);
  }
}
