<script lang="ts">
  import { onMount } from 'svelte';
  import * as BABYLON from '@babylonjs/core';
  import '@babylonjs/loaders/glTF';
  import HUD from './lib/HUD.svelte';
  import SettingsMenu from './lib/SettingsMenu.svelte';
  import { gameSettings } from './lib/stores';
  import { Game, type GameSystems } from './lib/core';
  import { InputManager } from './lib/core';
  import { eventBus, GameEvents } from './lib/core';

  interface PlayerPosition {
    x: number;
    y: number;
    z: number;
  }

  interface PlayerRotation {
    x: number;
    y: number;
    z: number;
  }

  interface PlayerData {
    id: string;
    position: PlayerPosition;
  }

  let canvas: HTMLCanvasElement;
  let game: Game;
  let systems: GameSystems;
  let inputManager: InputManager;

  let health = 100;
  let ammo = 30;
  let score = 0;
  let jetpackFuel = 100;
  let showMenu = false;
  let fps = 0;
  let velocityTotal = 0;
  let velocityHorizontal = 0;
  let velocityVertical = 0;

  let ws: WebSocket | null = null;
  let playerId: string | null = null;
  const otherPlayers = new Map<string, BABYLON.Mesh>();

  onMount(() => {
    let cleanupGame: (() => void) = () => {};
    let cleanupInput: (() => void) = () => {};
    let cleanupResize: (() => void) = () => {};

    const initialize = async () => {
      try {
        // Initialize game systems
        game = new Game(canvas);
        await game.initialize();
        systems = game.getSystems();
        
        // Initialize input manager
        inputManager = new InputManager();
        setupInputHandlers();
        setupEventListeners();

        // Start game loop
        game.start();

        // Setup jetpack fuel update loop
        const updateJetpackFuel = () => {
          if (systems) {
            jetpackFuel = systems.jetpackSystem.getFuelPercentage() * 100;
          }
          requestAnimationFrame(updateJetpackFuel);
        };
        updateJetpackFuel();

        // Setup FPS counter
        let frameCount = 0;
        let lastTime = performance.now();
        const updateFPS = () => {
          frameCount++;
          const currentTime = performance.now();
          if (currentTime - lastTime >= 1000) {
            fps = frameCount;
            frameCount = 0;
            lastTime = currentTime;
          }
          requestAnimationFrame(updateFPS);
        };
        updateFPS();

        // Setup networking
        connectWebSocket();

        // Handle window resize
        const handleResize = () => {
          game?.getSystems().scene.getEngine().resize();
        };
        window.addEventListener('resize', handleResize);
        cleanupResize = () => window.removeEventListener('resize', handleResize);

        // Setup cleanup function
        cleanupGame = () => {
          game?.dispose();
          inputManager?.dispose();
        };

      } catch (error) {
        console.error('Failed to initialize game:', error);
      }
    };

    // Start initialization
    initialize();

    // Return cleanup function
    return () => {
      cleanupGame();
      cleanupInput();
      cleanupResize();
    };
  });

  function setupInputHandlers(): void {
    if (!systems) return;

    // Keyboard events
    window.addEventListener('keydown', (e) => {
      inputManager.onKeyDown(e);
      // Handle Z key for view toggle separately
      if (e.code === 'KeyZ') {
        systems.playerController.toggleViewMode();
      }
    });
    window.addEventListener('keyup', (e) => inputManager.onKeyUp(e));

    // Mouse events
    canvas.addEventListener('mousedown', (e) => inputManager.onMouseDown(e));
    canvas.addEventListener('mouseup', (e) => inputManager.onMouseUp(e));
    canvas.addEventListener('mousemove', (e) => inputManager.onMouseMove(e));
    document.addEventListener('pointerlockchange', () => inputManager.onPointerLockChange());

    // Prevent context menu on right-click
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      return false;
    });

    // Click to lock pointer
    canvas.addEventListener('click', () => {
      if (!inputManager.isPointerLockedActive()) {
        canvas.requestPointerLock();
      }
    });
  }

  function setupEventListeners(): void {
    if (!systems) return;

    // Handle player movement via EventBus - emit input on every frame
    const emitInput = () => {
      const inputState = inputManager.getState();
      eventBus.emit('player:input', inputState);
      requestAnimationFrame(emitInput);
    };
    emitInput();

    // Handle weapon firing
    inputManager.on('shoot', (isShooting: boolean) => {
      systems.weaponSystem.setFiring(isShooting);
    });

    // Handle menu toggle
    inputManager.on('menu', () => {
      showMenu = !showMenu;
      if (showMenu) {
        document.exitPointerLock();
      } else {
        canvas.requestPointerLock();
      }
    });

    // Game events
    eventBus.on('enemy:destroy', () => {
      score += 100;
    });

    eventBus.on('explosion', () => {
      score += 10;
    });

    // Update velocity debug values every frame
    const updateVelocityDebug = () => {
      if (systems) {
        const velocity = systems.playerController.getVelocity();
        velocityTotal = velocity.length();
        velocityHorizontal = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
        velocityVertical = velocity.y;
      }
      requestAnimationFrame(updateVelocityDebug);
    };
    updateVelocityDebug();
  }

  function connectWebSocket() {
    ws = new WebSocket('ws://localhost:8080');

    ws.onopen = () => {
      console.log('Connected to server');
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'init':
          playerId = data.playerId;
          data.players.forEach((player: PlayerData) => {
            if (player.id !== playerId) {
              createOtherPlayer(player.id, player.position);
            }
          });
          break;

        case 'playerJoined':
          if (data.playerId !== playerId) {
            createOtherPlayer(data.playerId, data.position);
          }
          break;

        case 'playerUpdate':
          if (data.playerId !== playerId) {
            updateOtherPlayer(data.playerId, data.position, data.rotation);
          }
          break;

        case 'playerLeft':
          removeOtherPlayer(data.playerId);
          break;
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
    };
  }

  function createOtherPlayer(id: string, position: PlayerPosition) {
    if (!systems || otherPlayers.has(id)) return;

    const mesh = BABYLON.MeshBuilder.CreateBox(`player_${id}`, {
      width: 1,
      height: 2,
      depth: 1
    }, systems.scene);
    
    mesh.position = new BABYLON.Vector3(position.x, position.y, position.z);
    const mat = new BABYLON.StandardMaterial(`playerMat_${id}`, systems.scene);
    mat.diffuseColor = new BABYLON.Color3(1, 0.3, 0.3);
    mat.emissiveColor = new BABYLON.Color3(0.2, 0, 0);
    mesh.material = mat;

    otherPlayers.set(id, mesh);
  }

  function updateOtherPlayer(id: string, position: PlayerPosition, rotation: PlayerRotation) {
    const mesh = otherPlayers.get(id);
    if (mesh) {
      mesh.position = new BABYLON.Vector3(position.x, position.y, position.z);
      mesh.rotation = new BABYLON.Vector3(rotation.x, rotation.y, rotation.z);
    }
  }

  function removeOtherPlayer(id: string) {
    const mesh = otherPlayers.get(id);
    if (mesh) {
      mesh.dispose();
      otherPlayers.delete(id);
    }
  }

  function sendPositionUpdate(playerState: { position: BABYLON.Vector3; rotation: BABYLON.Vector3 }) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'positionUpdate',
        position: {
          x: playerState.position.x,
          y: playerState.position.y,
          z: playerState.position.z
        },
        rotation: {
          x: playerState.rotation.x,
          y: playerState.rotation.y,
          z: playerState.rotation.z
        }
      }));
    }
  }

  // Update game settings when they change
  $: if (systems && systems.playerController) {
    systems.playerController.setLookSensitivity($gameSettings.lookSensitivity);
    systems.playerController.setInvertY($gameSettings.invertY);
  }

  $: if (systems && systems.camera) {
    systems.camera.fov = ($gameSettings.fov * Math.PI) / 180;
  }
</script>

<svelte:head>
  <title>FPS Web Shooter</title>
</svelte:head>

<div class="game-container">
  <canvas bind:this={canvas} class="game-canvas"></canvas>
  <HUD {health} {ammo} {score} {jetpackFuel} {velocityTotal} {velocityHorizontal} {velocityVertical} />
  
  <div class="fps-counter">{fps}</div>
  
  <SettingsMenu bind:showMenu />
</div>

<style>
  :global(body, html) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .game-container {
    width: 100vw;
    height: 100vh;
    margin: 0;
    padding: 0;
    overflow: hidden;
    position: fixed;
    top: 0;
    left: 0;
  }

  .game-canvas {
    width: 100%;
    height: 100%;
    display: block;
    background: linear-gradient(to bottom, #0a1a4d 0%, #1e4d8c 40%, #4a90c2 70%, #87ceeb 100%);
  }

  .fps-counter {
    position: fixed;
    top: 10px;
    right: 10px;
    color: white;
    font-family: monospace;
    font-size: 16px;
    font-weight: bold;
    text-shadow: 1px 1px 2px black;
    pointer-events: none;
    z-index: 1000;
  }
</style>
