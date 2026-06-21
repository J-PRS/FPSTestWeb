<script lang="ts">
  import { gameSettings } from './stores';

  let showMenu = false;
  let sensitivityDisplay = 75; // 0-100 scale for display
  let invertY = true;
  let fov = 90;

  $: {
    sensitivityDisplay = Math.round($gameSettings.lookSensitivity * 100000);
    invertY = $gameSettings.invertY;
    fov = $gameSettings.fov;
  }

  function updateFov() {
    gameSettings.update(s => ({ ...s, fov }));
  }

  function updateSensitivity() {
    gameSettings.update(s => ({ ...s, lookSensitivity: sensitivityDisplay / 100000 }));
  }

  function updateInvertY() {
    gameSettings.update(s => ({ ...s, invertY }));
  }

  export { showMenu };
</script>

{#if showMenu}
  <div class="menu-overlay">
    <div class="menu">
      <h2>Settings</h2>
      
      <div class="setting">
        <label for="sensitivity">Mouse Sensitivity: {sensitivityDisplay}</label>
        <input
          id="sensitivity"
          type="range"
          min="1"
          max="200"
          step="1"
          bind:value={sensitivityDisplay}
          on:input={updateSensitivity}
        />
      </div>
      
      <div class="setting">
        <label for="invertY">Invert Y-Axis</label>
        <input id="invertY" type="checkbox" bind:checked={invertY} on:change={updateInvertY} />
      </div>
      
      <div class="setting">
        <label for="fov">FOV: {fov}°</label>
        <input
          id="fov"
          type="range"
          min="60"
          max="120"
          step="1"
          bind:value={fov}
          on:input={updateFov}
        />
      </div>
      
      <button class="resume-btn" on:click={() => showMenu = false}>
        Resume (ESC)
      </button>
    </div>
  </div>
{/if}

<style>
  .menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }

  .menu {
    background: rgba(30, 30, 40, 0.95);
    padding: 2rem;
    border-radius: 12px;
    min-width: 300px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .menu h2 {
    margin: 0 0 1.5rem 0;
    color: white;
    font-size: 1.5rem;
  }

  .setting {
    margin-bottom: 1.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .setting label {
    color: white;
    font-size: 0.9rem;
  }

  .setting input[type="range"] {
    width: 150px;
  }

  .setting input[type="checkbox"] {
    width: 20px;
    height: 20px;
  }

  .resume-btn {
    width: 100%;
    padding: 0.75rem;
    background: #4a9eff;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    margin-top: 1rem;
  }

  .resume-btn:hover {
    background: #3a8eef;
  }
</style>
