import { NetworkAdapterFactory } from './NetworkAdapterFactory';
import { NetworkManager } from './NetworkManager';
import { ChildLogger } from '../Logger.js';

const logger = new ChildLogger('NetworkingWorker');
logger.debug('Worker script loaded');

// Worker message types
type WorkerCommand = 
  | { type: 'connect'; url: string; playerId: string }
  | { type: 'disconnect' }
  | { type: 'sendInput'; input: any }
  | { type: 'sendPosition'; position: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number } }
  | { type: 'sendShot'; targetId: string | null; position?: { x: number; y: number; z: number }; velocity?: { x: number; y: number; z: number }; timestamp?: number; projectileId?: string | null }
  | { type: 'sendJump'; position: { x: number; y: number; z: number } }
  | { type: 'sendJetpack'; position: { x: number; y: number; z: number } }
  | { type: 'sendProjectileDestroy'; projectileId: string }
  | { type: 'getPing' }
  | { type: 'getPacketLoss' }
  | { type: 'getJitter' };


let networkManager: NetworkManager | null = null;

// Forward all NetworkManager callbacks to main thread
function setupCallbacks(nm: NetworkManager) {
  nm.onPlayerHit = (shooterId, targetId, damage) => {
    postMessage({ type: 'hit', shooterId, targetId, damage });
  };
  nm.onPlayerKill = (shooterId, targetId) => {
    postMessage({ type: 'kill', shooterId, targetId });
  };
  nm.onPlayerRespawn = (playerId, position, rotation) => {
    postMessage({ type: 'playerRespawn', playerId, position, rotation });
  };
  nm.onStateRestore = (state) => {
    postMessage({ type: 'stateRestore', state });
  };
  nm.onPlayerJump = (playerId, position) => {
    postMessage({ type: 'jump', playerId, position });
  };
  nm.onPlayerJetpack = (playerId, position) => {
    postMessage({ type: 'jetpack', playerId, position });
  };
  nm.onProjectileCreated = (projectileId, ownerId, position, velocity) => {
    postMessage({ type: 'projectileCreated', projectileId, ownerId, position, velocity });
  };
  nm.onProjectileUpdate = (projectileId, position) => {
    postMessage({ type: 'projectileUpdate', projectileId, position });
  };
  nm.onProjectileDestroyed = (projectileId) => {
    postMessage({ type: 'projectileDestroyed', projectileId });
  };
  nm.onPlayerJoined = (playerId, position, rotation) => {
    postMessage({ type: 'playerJoined', playerId, position, rotation });
  };
  nm.onPlayerLeft = (playerId) => {
    postMessage({ type: 'playerLeft', playerId });
  };
  nm.onPlayerUpdate = (playerId, position, rotation, timestamp) => {
    postMessage({ type: 'playerUpdate', playerId, position, rotation, timestamp });
  };
  nm.onGameState = (players, localPlayerState) => {
    postMessage({ type: 'gameState', players, localPlayerState });
  };
  nm.onStateReconciliation = (state) => {
    postMessage({ type: 'stateReconciliation', playerId: networkManager?.getLocalPlayerId() || '', data: state });
  };
}

// Handle messages from main thread
self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const data = e.data;

  switch (data.type) {
    case 'connect': {
      const adapter = NetworkAdapterFactory.createAdapter('tribes2');
      networkManager = new NetworkManager(adapter);
      networkManager.setPlayerId(data.playerId);

      setupCallbacks(networkManager);

      networkManager.connect(data.url).then(() => {
        postMessage({ type: 'connected' });
      }).catch((err) => {
        postMessage({ type: 'error', error: err.message });
      });
      break;
    }
    
    case 'disconnect':
      if (networkManager) {
        networkManager.disconnect();
        postMessage({ type: 'disconnected' });
      }
      break;
    
    case 'sendInput':
      if (networkManager) {
        networkManager.sendInput(data.input);
      }
      break;
    
    case 'sendPosition':
      if (networkManager) {
        networkManager.sendPosition(data.position, data.rotation);
      }
      break;
    
    case 'sendShot':
      if (networkManager) {
        logger.debug(`sendShot: ${data.targetId} ${JSON.stringify(data.position)} ${JSON.stringify(data.velocity)} ${data.timestamp} ${data.projectileId}`);
        networkManager.sendShot(data.targetId, data.position, data.velocity, data.timestamp, data.projectileId);
      }
      break;
    
    case 'sendJump':
      if (networkManager) {
        networkManager.sendJump(data.position);
      }
      break;
    
    case 'sendJetpack':
      if (networkManager) {
        networkManager.sendJetpack(data.position);
      }
      break;
    
    case 'sendProjectileDestroy':
      if (networkManager) {
        networkManager.sendProjectileDestroy(data.projectileId);
      }
      break;
    
    case 'getPing':
      if (networkManager) {
        postMessage({ type: 'ping', value: networkManager.getPing() });
      }
      break;
    
    case 'getPacketLoss':
      if (networkManager) {
        postMessage({ type: 'packetLoss', value: networkManager.getPacketLoss() });
      }
      break;
    
    case 'getJitter':
      if (networkManager) {
        postMessage({ type: 'jitter', value: networkManager.getJitter() });
      }
      break;
  }
};
