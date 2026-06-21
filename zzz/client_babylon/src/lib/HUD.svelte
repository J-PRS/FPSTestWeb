<script lang="ts">
  export let health = 100;
  export let ammo = 30;
  export let score = 0;
  export let jetpackFuel = 100;
  export let velocityTotal = 0;
  export let velocityHorizontal = 0;
  export let velocityVertical = 0;
</script>

<div class="hud">
  <div class="hud-center">
    <div class="crosshair"></div>
  </div>
  
  <div class="hud-stats">
    <div class="hud-item">
      <span class="hud-label">Health</span>
      <span class="hud-value">{health}</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">Ammo</span>
      <span class="hud-value">{ammo}</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">Vel Total</span>
      <span class="hud-value debug-value">{velocityTotal.toFixed(1)}</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">Vel Horiz</span>
      <span class="hud-value debug-value">{velocityHorizontal.toFixed(1)}</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">Vel Vert</span>
      <span class="hud-value debug-value">{velocityVertical.toFixed(1)}</span>
    </div>
    <div class="hud-item">
      <span class="hud-label">Jetpack</span>
      <div class="jetpack-fuel">
        <div class="jetpack-bar" style="width: {jetpackFuel}%"></div>
        <span class="jetpack-text">{Math.round(jetpackFuel)}%</span>
      </div>
    </div>
    <div class="hud-item">
      <span class="hud-label">Score</span>
      <span class="hud-value">{score}</span>
    </div>
  </div>
</div>

<style>
  .hud {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    padding-bottom: 40px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: white;
  }

  .hud-center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .crosshair {
    width: 4px;
    height: 4px;
    background: white;
    border-radius: 50%;
  }

  .hud-stats {
    display: flex;
    gap: 40px;
    align-items: center;
  }

  .hud-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .hud-label {
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.6);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .hud-value {
    font-size: 28px;
    font-weight: 600;
    color: white;
  }

  .debug-value {
    font-size: 18px;
    font-weight: 500;
    color: rgba(255, 255, 100, 0.8);
  }

  .jetpack-fuel {
    position: relative;
    width: 60px;
    height: 8px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    overflow: hidden;
  }

  .jetpack-bar {
    height: 100%;
    background: linear-gradient(90deg, #ff6b35, #f7931e);
    transition: width 0.3s ease;
    border-radius: 3px;
  }

  .jetpack-text {
    position: absolute;
    top: -18px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.8);
    text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
  }
</style>
