import * as pc from 'playcanvas';
import NetworkManager from './NetworkManager';
import { PlayerController } from './PlayerController';
import { Terrain } from './Terrain';

// Create application
const canvas = document.getElementById('application') as HTMLCanvasElement;
const app = new pc.Application(canvas, {
    graphicsDeviceOptions: {
        antialias: true
    }
});

app.start();

// Set canvas size to window size
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// Set up canvas resize
window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    app.resizeCanvas(canvas.width, canvas.height);
});

// Create scene
function createScene(): { cameraEntity: pc.Entity; terrain: Terrain } {
    // Create camera
    const cameraEntity = new pc.Entity('Camera');
    cameraEntity.addComponent('camera', {
        fov: 75,
        clearColor: new pc.Color(0.1, 0.1, 0.15)
    });
    cameraEntity.setPosition(0, 1.7, 0);
    app.root.addChild(cameraEntity);
    
    // Create ambient light
    const ambient = new pc.Entity('Ambient');
    ambient.addComponent('light', {
        type: 'ambient',
        color: new pc.Color(1, 1, 1),
        intensity: 1.0
    });
    app.root.addChild(ambient);
    
    // Create terrain
    const terrain = new Terrain(app);
    
    return { cameraEntity, terrain };
}

// Initialize
const { cameraEntity, terrain } = createScene();
const playerController = new PlayerController(cameraEntity, canvas, terrain);

// Network setup
const SERVER_URL = 'ws://localhost:8080';
const network = new NetworkManager(SERVER_URL);

network.onConnect((playerId: string) => {
    // console.log('Connected as player:', playerId);
});

network.setOnMessage((data: any) => {
    // Uncomment for debugging: console.log('Received:', data);
});

// UI updates
const fpsElement = document.getElementById('fps') as HTMLElement;
const pingElement = document.getElementById('ping') as HTMLElement;
const playersElement = document.getElementById('players') as HTMLElement;

let frameCount = 0;
let lastFpsUpdate = 0;

// Game loop
app.on('update', (dt: number) => {
    // Update player
    playerController.update(dt);
    
    // Update network
    network.update(dt);
    
    // Send position update
    if (network.isConnected()) {
        const pos = playerController.getPosition();
        const rot = playerController.getRotation();
        network.sendPositionUpdate(
            { x: pos.x, y: pos.y, z: pos.z },
            { x: rot.yaw, y: rot.pitch, z: 0 }
        );
    }
    
    // Update FPS counter
    frameCount++;
    const now = performance.now() / 1000;
    if (now - lastFpsUpdate >= 1.0) {
        fpsElement.textContent = frameCount.toString();
        frameCount = 0;
        lastFpsUpdate = now;
        
        // Update ping
        pingElement.textContent = Math.round(network.getLatency()).toString();
    }
});

// console.log('PlayCanvas FPS initialized');
// console.log('Click to lock mouse and play');
// console.log('WASD to move, Space to jump');
