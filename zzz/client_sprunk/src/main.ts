import { GameEngineWindow, Sprunk, GameObject, Camera, Color } from 'sprunk-engine';
import { GridRenderBehavior } from './GridRenderBehavior';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const startOverlay = document.getElementById('start-overlay')!;

// Enable Input and Render components
const game: GameEngineWindow = Sprunk.newGame(canvas, true, [
  "InputGameEngineComponent",
  "RenderGameEngineComponent",
]);

// Create camera
const cameraGo = new GameObject("Camera");
game.root.addChild(cameraGo);
cameraGo.addBehavior(new Camera());
cameraGo.transform.position.set(0, 2, 5);

// Add a test grid
const gridGo = new GameObject("Grid");
game.root.addChild(gridGo);
gridGo.addBehavior(new GridRenderBehavior(100, 1, Color.fromHex("#999")));
gridGo.transform.rotation.setFromEulerAngles(Math.PI / 2, 0, 0);

// Start
startOverlay.addEventListener('click', () => {
  startOverlay.classList.add('hidden');
  canvas.requestPointerLock();
});

console.log('Sprunk Engine FPS Game started');
