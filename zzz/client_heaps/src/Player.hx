class Player {

  static inline var WALK_SPEED    = 7.0;
  static inline var JUMP_IMPULSE  = 11.25; // JUMPIMPULSE / MASS = 9 / 0.8
  static inline var GRAVITY       = -20.0;
  static inline var JET_FORCE_UP  = 19.6;  // 70% of 28
  static inline var JET_FORCE_DIR = 14.0;  // 50% of 28
  static inline var AIR_CONTROL   = 8.0;
  static inline var MAX_ENERGY    = 60.0;
  static inline var JET_DRAIN     = 12.0;
  static inline var JET_CHARGE    = 8.0;
  static inline var PLAYER_HEIGHT = 1.8;
  static inline var FIRE_RATE     = 1.0; // seconds between shots

  var s3d     : h3d.scene.Scene;
  var terrain : Terrain;

  // Physics state
  public var pos       : h3d.Vector;
  public var vel       : h3d.Vector;
  var onGround         : Bool = false;
  var energy           : Float = MAX_ENERGY;
  var jumpCooldown     : Float = 0;

  // Camera
  public var yaw   : Float = 0;
  public var pitch : Float = 0;
  var camera: h3d.Camera;

  // Input
  var fireTimer  : Float = 0;
  var firePending : Bool = false;
  var mouseHeld   : Bool = false;
  var jetPending  : Bool = false;
  var keyW     : Bool = false;
  var keyA     : Bool = false;
  var keyS     : Bool = false;
  var keyD     : Bool = false;
  var keySpace : Bool = false;
  var keyUp    : Bool = false;
  var keyDown  : Bool = false;
  var keyLeft  : Bool = false;
  var keyRight : Bool = false;
  var keyR     : Bool = false; // Reload

  // HUD
  var hudText : h2d.Text;
  var networkQualityText : h2d.Text;
  var hitMarker : h2d.Graphics;
  
  // Networking
  var network : NetworkManager;
  var networkTimer : Float = 0;
  var pingTimer : Float = 0;
  static inline var NETWORK_UPDATE_RATE = 0.05; // 20 updates per second (batched)
  static inline var PING_INTERVAL = 1.0; // Send ping every second
  
  // Message batching
  var pendingUpdates : Array<{pos: {x:Float, y:Float, z:Float}, rot: {x:Float, y:Float, z:Float}, seq: Int}> = [];
  static inline var BATCH_SIZE = 3; // Send 3 updates per batch
  
  // Movement prediction
  var predictedPos : h3d.Vector = null;
  var serverPos : h3d.Vector = null;
  var lastServerUpdateTime : Float = 0;
  
  // Input buffering for prediction with sequence numbers
  var inputSequence : Int = 0;
  var inputBuffer : Array<{seq: Int, time: Float, inputs: {w:Bool, a:Bool, s:Bool, d:Bool, space:Bool, jet:Bool}, state: {pos: h3d.Vector, vel: h3d.Vector, onGround: Bool, energy: Float, jumpCooldown: Float}}> = [];
  static inline var INPUT_BUFFER_SIZE = 60; // 1 second at 60Hz
  var lastAcknowledgedSeq : Int = -1;
  
  // Hit marker
  var hitMarkerTimer : Float = 0;
  static inline var HIT_MARKER_DURATION = 0.1; // 100ms
  
  // Health
  var health : Float = 100.0;
  static inline var MAX_HEALTH = 100.0;
  var healthText : h2d.Text;
  
  // Kills
  var kills : Int = 0;
  var killsText : h2d.Text;
  
  // Ammo system
  var ammo : Int = 10;
  static inline var MAX_AMMO = 10;
  var reloadTimer : Float = 0;
  static inline var RELOAD_TIME = 2.0;
  var isReloading : Bool = false;
  var ammoText : h2d.Text;
  
  // Team indicator
  var teamText : h2d.Text;
  
  // Connection status
  var connectionText : h2d.Text;
  
  // Crosshair
  var crosshair : h2d.Graphics;
  
  // Spawn protection
  var spawnProtectionTimer : Float = 0;
  static inline var SPAWN_PROTECTION_TIME = 3.0; // 3 seconds of invulnerability
  var isSpawnProtected : Bool = false;
  
  // Team system
  public var team : Int = 0; // 0 = red, 1 = blue
  static inline var TEAM_RED = 0;
  static inline var TEAM_BLUE = 1;
  
  // Death/spectator state
  public var isDead : Bool = false;
  var spectatorTarget : RemotePlayer = null;
  var deathText : h2d.Text;
  var respawnTimer : Float = 0;
  var respawnText : h2d.Text;
  var spectatorText : h2d.Text;
  
  // Damage feedback
  var damageOverlay : h2d.Graphics;
  var damageFlashTimer : Float = 0;
  var damageDirection : h3d.Vector = null; // Direction damage came from
  var damageIndicator : h2d.Graphics;
  
  // Jump callback
  public var onJump : h3d.Vector -> Void = null;
  
  // Collision
  static inline var PLAYER_RADIUS = 0.5;
  var remotePlayersRef : Map<String, RemotePlayer> = null;
  
  public function setRemotePlayersRef(ref: Map<String, RemotePlayer>) {
    remotePlayersRef = ref;
  }
  
  // Spectator cycle callback
  public var onSpectatorCycle : Void -> Void = null;
  
  // Footstep callback for running dust
  public var onFootstep : h3d.Vector -> Void = null;
  var footstepTimer : Float = 0;
  static inline var FOOTSTEP_INTERVAL = 0.12;  // spawn dust every X seconds while running
  
  // Jetpack callback for continuous particles
  public var onJetpack : h3d.Vector -> Void = null;
  var jetpackTimer : Float = 0;
  static inline var JETPACK_PARTICLE_INTERVAL = 0.03;  // spawn every 30ms

  public function new(s3d: h3d.scene.Scene, s2d: h2d.Scene, terrain: Terrain, ?network: NetworkManager) {
    this.s3d     = s3d;
    this.terrain = terrain;
    this.network = network;
    camera       = s3d.camera;

    var startH = terrain.getHeight(0, 0);
    pos = new h3d.Vector(0, startH + 10, 0);
    vel = new h3d.Vector(0, 0, 0);
    
    // Initialize prediction vectors
    predictedPos = pos.clone();
    serverPos = pos.clone();

    camera.fovY = 90;
    camera.zNear = 0.1;
    camera.zFar = 6000;

    // HUD
    var font = hxd.res.DefaultFont.get();
    hudText = new h2d.Text(font, s2d);
    hudText.textColor = 0xFFFFFF;
    hudText.x = 10; hudText.y = 10;
    hudText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    
    // Network quality indicator (right side, below FPS)
    networkQualityText = new h2d.Text(font, s2d);
    networkQualityText.textColor = 0x00FF00;
    networkQualityText.textAlign = Right;
    networkQualityText.x = s2d.width - 10; networkQualityText.y = 30;
    networkQualityText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    networkQualityText.setScale(1.0);
    
    // Connection status (right side, below network quality)
    connectionText = new h2d.Text(font, s2d);
    connectionText.textColor = 0x00FF00;
    connectionText.textAlign = Right;
    connectionText.x = s2d.width - 10; connectionText.y = 50;
    connectionText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    connectionText.setScale(1.0);
    
    // Hit marker (X shape in center of screen)
    hitMarker = new h2d.Graphics(s2d);
    hitMarker.x = s2d.width / 2;
    hitMarker.y = s2d.height / 2;
    hitMarker.visible = false;
    
    // Crosshair (center of screen)
    crosshair = new h2d.Graphics(s2d);
    crosshair.x = s2d.width / 2;
    crosshair.y = s2d.height / 2;
    var chSize = 8.0;
    var chGap = 4.0;
    crosshair.lineStyle(2, 0xFFFFFF, 0.8);
    // Top line
    crosshair.moveTo(0, -chGap - chSize);
    crosshair.lineTo(0, -chGap);
    // Bottom line
    crosshair.moveTo(0, chGap);
    crosshair.lineTo(0, chGap + chSize);
    // Left line
    crosshair.moveTo(-chGap - chSize, 0);
    crosshair.lineTo(-chGap, 0);
    // Right line
    crosshair.moveTo(chGap, 0);
    crosshair.lineTo(chGap + chSize, 0);
    
    // Health display
    healthText = new h2d.Text(font, s2d);
    healthText.textColor = 0xFF4444;
    healthText.x = 10; healthText.y = 90;
    healthText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    
    // Kills display
    killsText = new h2d.Text(font, s2d);
    killsText.textColor = 0xFFFF44;
    killsText.x = 10; killsText.y = 115;
    killsText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    
    // Ammo display
    ammoText = new h2d.Text(font, s2d);
    ammoText.textColor = 0x44FF44;
    ammoText.x = 10; ammoText.y = 140;
    ammoText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    
    // Team indicator
    teamText = new h2d.Text(font, s2d);
    teamText.text = 'TEAM: RED';
    teamText.textColor = 0xFF4444;
    teamText.x = 10; teamText.y = 165;
    teamText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    
    // Death message
    deathText = new h2d.Text(font, s2d);
    deathText.text = 'YOU ARE DEAD - SPECTATING';
    deathText.textColor = 0xFF0000;
    deathText.textAlign = Center;
    deathText.x = s2d.width / 2;
    deathText.y = s2d.height / 2;
    deathText.dropShadow = { dx: 2, dy: 2, color: 0x000000, alpha: 0.9 };
    deathText.setScale(1.5);
    deathText.visible = false;
    
    // Respawn timer
    respawnText = new h2d.Text(font, s2d);
    respawnText.text = 'RESPAWN IN: 3';
    respawnText.textColor = 0xFFFFFF;
    respawnText.textAlign = Center;
    respawnText.x = s2d.width / 2;
    respawnText.y = s2d.height / 2 + 40;
    respawnText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    respawnText.setScale(1.2);
    respawnText.visible = false;
    
    // Spectator info
    spectatorText = new h2d.Text(font, s2d);
    spectatorText.text = 'SPECTATING: (Press TAB to cycle)';
    spectatorText.textColor = 0xAAAAFF;
    spectatorText.textAlign = Center;
    spectatorText.x = s2d.width / 2;
    spectatorText.y = s2d.height / 2 + 70;
    spectatorText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    spectatorText.setScale(0.9);
    spectatorText.visible = false;
    
    // Damage direction indicator
    damageIndicator = new h2d.Graphics(s2d);
    damageIndicator.x = s2d.width / 2;
    damageIndicator.y = s2d.height / 2;
    damageIndicator.visible = false;
    
    // Damage overlay (red flash)
    damageOverlay = new h2d.Graphics(s2d);
    damageOverlay.beginFill(0xFF0000, 0.3);
    damageOverlay.drawRect(0, 0, 2000, 2000);
    damageOverlay.endFill();
    damageOverlay.visible = false;

    // Mouse move listener
    #if js
    js.Browser.document.addEventListener("mousemove", function(e: js.html.MouseEvent) {
      if (js.Browser.document.pointerLockElement != null) {
        yaw   += e.movementX * 0.002;
        pitch += e.movementY * 0.002;
        pitch = hxd.Math.clamp(pitch, -Math.PI/2 + 0.01, Math.PI/2 - 0.01);
      }
    });
    js.Browser.document.addEventListener("mousedown", function(e: js.html.MouseEvent) {
      if (e.button == 0) { firePending = true; mouseHeld = true; }
      if (e.button == 2) jetPending  = true;
    });
    js.Browser.document.addEventListener("mouseup", function(e: js.html.MouseEvent) {
      if (e.button == 0) mouseHeld = false;
      if (e.button == 2) jetPending = false;
    });
    js.Browser.document.addEventListener("contextmenu", function(e) e.preventDefault());
    js.Browser.window.addEventListener("keydown", function(e: js.html.KeyboardEvent) {
      js.Browser.console.log("keydown: " + e.code);
      switch(e.code) {
        case "KeyW":      keyW     = true;
        case "KeyA":      keyA     = true;
        case "KeyS":      keyS     = true;
        case "KeyD":      keyD     = true;
        case "Space":     keySpace = true;
        case "ArrowUp":   keyUp    = true;
        case "ArrowDown": keyDown  = true;
        case "ArrowLeft": keyLeft  = true;
        case "ArrowRight":keyRight = true;
        case "KeyR":      keyR     = true;
        case "Tab":
          if (isDead) {
            e.preventDefault();
            if (onSpectatorCycle != null) {
              onSpectatorCycle();
            }
          }
        default:
      }
    }, true);
    js.Browser.window.addEventListener("keyup", function(e: js.html.KeyboardEvent) {
      switch(e.code) {
        case "KeyW":      keyW     = false;
        case "KeyA":      keyA     = false;
        case "KeyS":      keyS     = false;
        case "KeyD":      keyD     = false;
        case "Space":     keySpace = false;
        case "ArrowUp":   keyUp    = false;
        case "ArrowDown": keyDown  = false;
        case "ArrowLeft": keyLeft  = false;
        case "ArrowRight":keyRight = false;
        case "KeyR":      keyR     = false;
        default:
      }
    }, true);
    #end
  }

  public function update(dt: Float) {
    handleInput(dt);
    applyPhysics(dt);
    updateCamera();
    updateHUD();
    fireTimer = Math.max(0, fireTimer - dt);
    
    // Update damage flash
    if (damageFlashTimer > 0) {
      damageFlashTimer -= dt;
      damageOverlay.visible = true;
      damageOverlay.alpha = damageFlashTimer * 0.3;
      
      // Update damage direction indicator
      if (damageDirection != null) {
        damageIndicator.visible = true;
        damageIndicator.clear();
        
        // Calculate screen direction from damage source
        var camDir = new h3d.Vector();
        camDir.x = camera.target.x - camera.pos.x;
        camDir.y = camera.target.y - camera.pos.y;
        camDir.z = camera.target.z - camera.pos.z;
        camDir.normalize();
        
        var camYaw = Math.atan2(camDir.x, camDir.z);
        
        // Calculate angle to damage source
        var dx = damageDirection.x - pos.x;
        var dz = damageDirection.z - pos.z;
        var angleToDamage = Math.atan2(dx, dz);
        
        // Calculate screen angle
        var screenAngle = angleToDamage - camYaw;
        
        // Draw arrow pointing toward damage
        var radius = 150;
        var arrowX = Math.cos(screenAngle) * radius;
        var arrowY = Math.sin(screenAngle) * radius;
        
        damageIndicator.lineStyle(4, 0xFF0000);
        damageIndicator.drawCircle(0, 0, radius, 16);
        
        // Draw arrow head
        var arrowSize = 20;
        var arrowAngle = screenAngle + Math.PI / 2;
        damageIndicator.moveTo(arrowX, arrowY);
        damageIndicator.lineTo(
          arrowX + Math.cos(arrowAngle - 0.3) * arrowSize,
          arrowY + Math.sin(arrowAngle - 0.3) * arrowSize
        );
        damageIndicator.moveTo(arrowX, arrowY);
        damageIndicator.lineTo(
          arrowX + Math.cos(arrowAngle + 0.3) * arrowSize,
          arrowY + Math.sin(arrowAngle + 0.3) * arrowSize
        );
      }
      
      if (damageFlashTimer <= 0) {
        damageOverlay.visible = false;
        damageIndicator.visible = false;
        damageDirection = null;
      }
    }
    
    // Update respawn timer
    if (isDead && respawnTimer > 0) {
      respawnTimer -= dt;
      respawnText.text = 'RESPAWN IN: ${Math.ceil(respawnTimer)}';
      if (respawnTimer <= 0) {
        respawnText.text = 'RESPAWNING...';
      }
    }
    
    // Handle reload
    if (keyR && !isReloading && ammo < MAX_AMMO) {
      isReloading = true;
      reloadTimer = RELOAD_TIME;
    }
    
    if (isReloading) {
      reloadTimer -= dt;
      if (reloadTimer <= 0) {
        isReloading = false;
        ammo = MAX_AMMO;
      }
    }
    
    // Update spawn protection
    if (isSpawnProtected) {
      spawnProtectionTimer -= dt;
      if (spawnProtectionTimer <= 0) {
        isSpawnProtected = false;
      }
    }
    
    // Update hit marker
    if (hitMarkerTimer > 0) {
      hitMarkerTimer -= dt;
      if (hitMarkerTimer > 0) {
        hitMarker.visible = true;
        // Draw X shape
        hitMarker.clear();
        hitMarker.lineStyle(3, 0xFFFFFF);
        var size = 15;
        hitMarker.moveTo(-size, -size);
        hitMarker.lineTo(size, size);
        hitMarker.moveTo(size, -size);
        hitMarker.lineTo(-size, size);
      } else {
        hitMarker.visible = false;
      }
    }
    
    // Network position updates with batching
    if (network != null && network.isConnected()) {
      networkTimer += dt;
      if (networkTimer >= NETWORK_UPDATE_RATE) {
        networkTimer = 0;
        
        // Add update to batch
        pendingUpdates.push({
          pos: {x: pos.x, y: pos.y, z: pos.z},
          rot: {x: pitch, y: yaw, z: 0},
          seq: inputSequence - 1
        });
        
        // Send batch when full
        if (pendingUpdates.length >= BATCH_SIZE) {
          network.sendBatchedPositionUpdates(pendingUpdates);
          pendingUpdates = [];
        }
      }
      
      // Send ping for latency measurement
      pingTimer += dt;
      if (pingTimer >= PING_INTERVAL) {
        pingTimer = 0;
        network.sendPing();
      }
      
      // Server reconciliation - disabled for now to fix movement issue
      // The aggressive reconciliation was interfering with player movement
      // TODO: Implement proper client-side prediction with reconciliation
      /*
      if (serverPos != null) {
        reconciliationTimer += dt;
        var lerpSpeed = 20.0; // Faster correction for responsiveness
        var lerp = Math.min(1.0, reconciliationTimer * lerpSpeed);
        
        // Calculate position difference
        var diffX = serverPos.x - pos.x;
        var diffY = serverPos.y - pos.y;
        var diffZ = serverPos.z - pos.z;
        var diff = Math.sqrt(diffX*diffX + diffY*diffY + diffZ*diffZ);
        
        // If difference is large, snap quickly (rubberband prevention)
        if (diff > 2.0) {
          lerp = 1.0; // Instant snap for large corrections
        }
        
        pos.x = pos.x + diffX * lerp * dt * lerpSpeed;
        pos.y = pos.y + diffY * lerp * dt * lerpSpeed;
        pos.z = pos.z + diffZ * lerp * dt * lerpSpeed;
      }
      */
    }
  }

  function handleInput(dt: Float) {
    // Block all movement when dead/spectating
    if (isDead) {
      return;
    }
    
    var forward = getForwardXZ();
    var right   = getRightXZ();

    var moveDir = new h3d.Vector(0, 0, 0);
    if (keyW || keyUp)    { moveDir.x += forward.x; moveDir.z += forward.z; }
    if (keyS || keyDown)  { moveDir.x -= forward.x; moveDir.z -= forward.z; }
    if (keyA || keyLeft)  { moveDir.x -= right.x;   moveDir.z -= right.z; }
    if (keyD || keyRight) { moveDir.x += right.x;   moveDir.z += right.z; }
    
    // Buffer inputs for prediction with sequence numbers
    if (network != null && network.isConnected()) {
      #if js
      var now = haxe.Timer.stamp();
      #else
      var now = Sys.time();
      #end
      inputBuffer.push({
        seq: inputSequence,
        time: now,
        inputs: {w: keyW || keyUp, a: keyA || keyLeft, s: keyS || keyDown, d: keyD || keyRight, space: keySpace, jet: jetPending},
        state: {pos: pos.clone(), vel: vel.clone(), onGround: onGround, energy: energy, jumpCooldown: jumpCooldown}
      });
      inputSequence++;
      if (inputBuffer.length > INPUT_BUFFER_SIZE) {
        inputBuffer.shift();
      }
    }

    var movelen = Math.sqrt(moveDir.x * moveDir.x + moveDir.z * moveDir.z);
    if (movelen > 0) { moveDir.x /= movelen; moveDir.z /= movelen; }

    var isJumping = keySpace;
    var isJetting = jetPending && !onGround && energy > 0;
    var isSkiing  = keySpace && onGround;

    // Energy recharge
    energy = Math.min(MAX_ENERGY, energy + JET_CHARGE * dt);

    // Ground friction / walking
    if (onGround && !isSkiing) {
      var targetX = moveDir.x * WALK_SPEED;
      var targetZ = moveDir.z * WALK_SPEED;
      vel.x += (targetX - vel.x) * 0.5;
      vel.z += (targetZ - vel.z) * 0.5;
      
      // Footstep dust while running
      var speed = Math.sqrt(vel.x*vel.x + vel.z*vel.z);
      if (speed > 5.0) {
        footstepTimer += dt;
        if (footstepTimer >= FOOTSTEP_INTERVAL) {
          footstepTimer = 0;
          if (onFootstep != null) {
            var groundPos = pos.clone();
            groundPos.y = terrain.getHeight(pos.x, pos.z);
            onFootstep(groundPos);
          }
        }
      } else {
        footstepTimer = FOOTSTEP_INTERVAL;  // reset so next step happens when we start running
      }
    }

    // Jump off ground
    if (isJumping && onGround && jumpCooldown <= 0) {
      vel.y = JUMP_IMPULSE;
      onGround = false;
      jumpCooldown = 0.3;
      // Trigger jump dust callback at ground level
      if (onJump != null) {
        var groundPos = pos.clone();
        groundPos.y = terrain.getHeight(pos.x, pos.z);
        onJump(groundPos);
      }
    }

    // Jetpack
    if (isJetting) {
      vel.y  += JET_FORCE_UP * dt;
      vel.x  += moveDir.x * JET_FORCE_DIR * dt;
      vel.z  += moveDir.z * JET_FORCE_DIR * dt;
      energy -= JET_DRAIN * dt;
      
      // Spawn jetpack particles
      jetpackTimer += dt;
      if (jetpackTimer >= JETPACK_PARTICLE_INTERVAL) {
        jetpackTimer = 0;
        if (onJetpack != null) onJetpack(pos.clone());
      }
    }

    // Air control
    if (!onGround && !isJetting && movelen > 0) {
      vel.x += moveDir.x * AIR_CONTROL * dt;
      vel.z += moveDir.z * AIR_CONTROL * dt;
    }

    jumpCooldown -= dt;
  }

  function applyPhysics(dt: Float) {
    // Gravity
    vel.y += GRAVITY * dt;

    // Integrate
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;

    // Player-to-player collision (client-side prediction)
    if (remotePlayersRef != null) {
      for (rp in remotePlayersRef) {
        if (rp.isDead) continue; // Skip dead players
        if (rp.team == team) continue; // Skip teammates (no collision)
        
        var dx = pos.x - rp.pos.x;
        var dz = pos.z - rp.pos.z;
        var distXZ = Math.sqrt(dx*dx + dz*dz);
        var minDist = PLAYER_RADIUS * 2; // Combined radius
        
        if (distXZ < minDist && distXZ > 0.01) {
          // Push apart
          var pushForce = (minDist - distXZ) * 10.0;
          var pushX = (dx / distXZ) * pushForce * dt;
          var pushZ = (dz / distXZ) * pushForce * dt;
          
          pos.x += pushX;
          pos.z += pushZ;
          vel.x += pushX * 0.5;
          vel.z += pushZ * 0.5;
        }
      }
    }

    // Terrain collision
    var groundY = terrain.getHeight(pos.x, pos.z) + PLAYER_HEIGHT;
    if (pos.y <= groundY) {
      pos.y = groundY;
      if (vel.y < 0) vel.y = 0;
      onGround = true;
    } else {
      onGround = false;
    }

  }

  function updateCamera() {
    camera.pos.set(pos.x, pos.y, pos.z);
    var tx = pos.x + Math.cos(pitch) * Math.sin(yaw);
    var ty = pos.y + Math.sin(pitch);
    var tz = pos.z + Math.cos(pitch) * Math.cos(yaw);
    camera.target.set(tx, ty, tz);
    camera.up.set(0, 1, 0);
  }

  function updateHUD() {
    var speed = Math.sqrt(vel.x*vel.x + vel.z*vel.z);
    var total = Math.sqrt(vel.x*vel.x + vel.y*vel.y + vel.z*vel.z);
    
    // Update network quality indicator
    if (network != null && network.isConnected()) {
      var quality = network.getNetworkQuality();
      var qualityPercent = Math.round(quality * 100);
      var latency = Math.round(network.getLatency());
      networkQualityText.text = 'NET: ${qualityPercent}% PING: ${latency}ms';
      
      // Color based on quality
      if (quality >= 0.8) {
        networkQualityText.textColor = 0x00FF00; // Green
      } else if (quality >= 0.5) {
        networkQualityText.textColor = 0xFFFF00; // Yellow
      } else {
        networkQualityText.textColor = 0xFF0000; // Red
      }
    } else {
      networkQualityText.text = 'NET: DISCONNECTED';
      networkQualityText.textColor = 0xFF0000; // Red when disconnected
    }
    
    // Update connection status
    if (network != null && network.isConnected()) {
      connectionText.text = 'CONNECTED';
      connectionText.textColor = 0x00FF00;
    } else {
      connectionText.text = 'OFFLINE';
      connectionText.textColor = 0xFF0000;
    }
    
    hudText.text =
      'Speed H: ${Math.round(speed)} V: ${Math.round(Math.abs(vel.y))} Total: ${Math.round(total)}\n' +
      'Energy: ${Math.round(energy)}/${Math.round(MAX_ENERGY)}\n' +
      '${onGround ? "GROUND" : "AIR"}\n' +
      'WASD=move  SPACE=jump/ski  RMB=jetpack  LMB=fire';
    
    healthText.text = 'Health: ${Math.round(health)}/${Math.round(MAX_HEALTH)}';
    killsText.text = 'Kills: $kills';
    
    // Update ammo display
    if (isReloading) {
      ammoText.text = 'RELOADING: ${Math.ceil(reloadTimer)}s';
      ammoText.textColor = 0xFFFF00; // Yellow when reloading
    } else {
      ammoText.text = 'Ammo: $ammo/$MAX_AMMO';
      ammoText.textColor = ammo <= 3 ? 0xFF0000 : 0x44FF44; // Red when low
    }
    
    // Update spawn protection display
    if (isSpawnProtected) {
      ammoText.text = 'PROTECTED: ${Math.ceil(spawnProtectionTimer)}s';
      ammoText.textColor = 0x00FFFF; // Cyan when protected
    } else if (!isReloading) {
      ammoText.text = 'Ammo: $ammo/$MAX_AMMO';
      ammoText.textColor = ammo <= 3 ? 0xFF0000 : 0x44FF44; // Red when low
    }
    
    // Update team indicator
    if (team == TEAM_RED) {
      teamText.text = 'TEAM: RED';
      teamText.textColor = 0xFF4444;
    } else {
      teamText.text = 'TEAM: BLUE';
      teamText.textColor = 0x4444FF;
    }
  }

  public function wantsToFire() : Bool {
    if (isDead) return false;
    if (isReloading) return false;
    // Auto-reload when empty
    if (ammo <= 0) {
      if (!isReloading) {
        isReloading = true;
        reloadTimer = RELOAD_TIME;
      }
      return false;
    }
    if ((firePending || mouseHeld) && fireTimer <= 0) {
      firePending = false;
      fireTimer = FIRE_RATE;
      ammo--;
      // Auto-reload when depleted
      if (ammo <= 0) {
        isReloading = true;
        reloadTimer = RELOAD_TIME;
      }
      return true;
    }
    firePending = false;
    return false;
  }

  public function getCameraPos() : h3d.Vector return pos.clone();
  public function getCameraDir() : h3d.Vector {
    return new h3d.Vector(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw)
    ).normalized();
  }
  public function getVelocity() : h3d.Vector return vel.clone();

  // Apply knockback impulse from explosion (for rocket jumping)
  public function applyKnockback(fromX: Float, fromY: Float, fromZ: Float, force: Float) {
    var dx = pos.x - fromX;
    var dy = pos.y - fromY;
    var dz = pos.z - fromZ;
    var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < 0.1) dist = 0.1;
    // Normalize and apply force
    vel.x += (dx / dist) * force;
    vel.y += (dy / dist) * force * 0.8;  // more vertical for rocket jumping
    vel.z += (dz / dist) * force;
  }
  
  public function triggerDamageFlash(?fromPos: h3d.Vector) {
    damageFlashTimer = 0.3; // 0.3 second red flash
    if (fromPos != null) {
      damageDirection = fromPos;
    }
  }
  
  public function predictDeath() {
    if (!isDead) {
      isDead = true;
      deathText.visible = true;
      respawnText.visible = true;
      spectatorText.visible = true;
      if (crosshair != null) crosshair.visible = false;
      respawnTimer = 3.0; // 3 second respawn
    }
  }
  
  public function getHealth() : Float {
    return health;
  }
  
  public function takeDamage(amount: Float, ?fromPos: h3d.Vector) {
    // Spawn protection prevents damage
    if (isSpawnProtected) {
      return;
    }
    
    health = Math.max(0, health - amount);
    triggerDamageFlash(fromPos); // Use the new method with direction
    if (health <= 0 && !isDead) {
      isDead = true;
      deathText.visible = true;
      respawnText.visible = true;
      spectatorText.visible = true;
      if (crosshair != null) crosshair.visible = false;
      respawnTimer = 3.0; // 3 second respawn
    }
  }
  
  public function resetHealth() {
    health = MAX_HEALTH;
    isDead = false;
    deathText.visible = false;
    respawnText.visible = false;
    spectatorText.visible = false;
    if (crosshair != null) crosshair.visible = true;
    respawnTimer = 0;
    spectatorTarget = null;
    
    // Activate spawn protection
    isSpawnProtected = true;
    spawnProtectionTimer = SPAWN_PROTECTION_TIME;
  }
  
  public function addKill() {
    kills++;
  }
  
  public function getKills() : Int {
    return kills;
  }
  
  public function resetKills() {
    kills = 0;
  }
  
  public function setSpectatorTarget(target: RemotePlayer) {
    spectatorTarget = target;
    if (target != null) {
      spectatorText.text = 'SPECTATING: ${target.playerName} (Press TAB to cycle)';
    }
  }
  
  public function getSpectatorTarget() : RemotePlayer {
    return spectatorTarget;
  }
  
  public function updateServerPosition(x: Float, y: Float, z: Float, ackSeq: Int) {
    if (serverPos == null) {
      serverPos = new h3d.Vector(x, y, z);
    } else {
      serverPos.set(x, y, z);
    }
    lastServerUpdateTime = haxe.Timer.stamp();
    
    // Reconcile: remove acknowledged inputs from buffer
    if (ackSeq >= 0) {
      lastAcknowledgedSeq = ackSeq;
      // Remove inputs with sequence <= ackSeq
      var i = 0;
      while (i < inputBuffer.length) {
        if (inputBuffer[i].seq <= ackSeq) {
          inputBuffer.splice(i, 1);
        } else {
          i++;
        }
      }
      
      // If we have unacknowledged inputs, replay them from server position
      if (inputBuffer.length > 0) {
        // Rewind to server position
        pos.set(x, y, z);
        vel.set(0, 0, 0); // Reset velocity for replay
        onGround = true; // Assume on ground for replay start
        energy = inputBuffer[0].state.energy; // Restore energy
        jumpCooldown = inputBuffer[0].state.jumpCooldown; // Restore jump cooldown
        
        // Replay all unacknowledged inputs with full physics
        for (input in inputBuffer) {
          var dt = 0.016; // Fixed timestep for replay
          
          // Apply movement input
          var forward = getForwardXZ();
          var right = getRightXZ();
          var moveDir = new h3d.Vector(0, 0, 0);
          if (input.inputs.w) { moveDir.x += forward.x; moveDir.z += forward.z; }
          if (input.inputs.s) { moveDir.x -= forward.x; moveDir.z -= forward.z; }
          if (input.inputs.a) { moveDir.x -= right.x;   moveDir.z -= right.z; }
          if (input.inputs.d) { moveDir.x += right.x;   moveDir.z += right.z; }
          
          var movelen = Math.sqrt(moveDir.x * moveDir.x + moveDir.z * moveDir.z);
          if (movelen > 0) { moveDir.x /= movelen; moveDir.z /= movelen; }
          
          // Ground movement
          if (onGround) {
            var targetX = moveDir.x * WALK_SPEED;
            var targetZ = moveDir.z * WALK_SPEED;
            vel.x += (targetX - vel.x) * 0.5;
            vel.z += (targetZ - vel.z) * 0.5;
          } else {
            // Air control
            vel.x += moveDir.x * AIR_CONTROL * dt;
            vel.z += moveDir.z * AIR_CONTROL * dt;
          }
          
          // Jump
          if (input.inputs.space && onGround && jumpCooldown <= 0) {
            vel.y = JUMP_IMPULSE;
            onGround = false;
            jumpCooldown = 0.3;
          }
          
          // Jetpack
          if (input.inputs.jet && !onGround && energy > 0) {
            vel.y += JET_FORCE_UP * dt;
            vel.x += moveDir.x * JET_FORCE_DIR * dt;
            vel.z += moveDir.z * JET_FORCE_DIR * dt;
            energy = Math.max(0, energy - JET_DRAIN * dt);
          }
          
          // Gravity
          vel.y += GRAVITY * dt;
          
          // Energy recharge
          energy = Math.min(MAX_ENERGY, energy + JET_CHARGE * dt);
          
          // Update cooldown
          jumpCooldown = Math.max(0, jumpCooldown - dt);
          
          // Apply velocity
          pos.x += vel.x * dt;
          pos.y += vel.y * dt;
          pos.z += vel.z * dt;
          
          // Ground collision (simplified)
          var groundH = terrain.getHeight(pos.x, pos.z);
          if (pos.y < groundH + PLAYER_HEIGHT) {
            pos.y = groundH + PLAYER_HEIGHT;
            vel.y = 0;
            onGround = true;
          }
        }
      }
    }
  }
  
  public function showHitMarker() {
    hitMarkerTimer = HIT_MARKER_DURATION;
  }
  
  public function cycleSpectatorTarget(remotePlayers: Map<String, RemotePlayer>) {
    var playersArray = new Array<RemotePlayer>();
    for (rp in remotePlayers) {
      if (rp.health > 0) {
        playersArray.push(rp);
      }
    }
    
    if (playersArray.length == 0) {
      spectatorTarget = null;
      spectatorText.text = 'SPECTATING: No players alive';
      return;
    }
    
    if (spectatorTarget == null) {
      spectatorTarget = playersArray[0];
    } else {
      var currentIndex = -1;
      for (i in 0...playersArray.length) {
        if (playersArray[i] == spectatorTarget) {
          currentIndex = i;
          break;
        }
      }
      var nextIndex = (currentIndex + 1) % playersArray.length;
      spectatorTarget = playersArray[nextIndex];
    }
    
    spectatorText.text = 'SPECTATING: ${spectatorTarget.playerName} (Press TAB to cycle)';
  }

  function getForwardXZ() : h3d.Vector {
    return new h3d.Vector(Math.sin(yaw), 0, Math.cos(yaw)).normalized();
  }
  function getRightXZ() : h3d.Vector {
    return new h3d.Vector(Math.cos(yaw), 0, -Math.sin(yaw)).normalized();
  }
}
