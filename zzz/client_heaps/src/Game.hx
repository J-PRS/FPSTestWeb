class Game {

  var s3d   : h3d.scene.Scene;
  var s2d   : h2d.Scene;
  var engine: h3d.Engine;

  var player     : Player;
  var terrain    : Terrain;
  var sky        : Sky;
  var weapon     : WeaponModel;
  var fpsText    : h2d.Text;
  var statsText  : h2d.Text;
  var playerListText : h2d.Text;
  var roundTimerText : h2d.Text;

  var network     : NetworkManager;
  var wasConnected : Bool = false;
  var remotePlayers : Map<String, RemotePlayer> = new Map();
  var remoteRockets : Map<String, Rocket> = new Map();
  var remoteRocketTrails : Map<String, RocketTrail> = new Map();
  var scoreboard : h2d.Text;
  var playerScores : Map<String, Int> = new Map();
  var teamScores : Map<Int, Int> = new Map(); // 0 = red, 1 = blue
  var roundTimer : Float = 0; // Track round time in seconds

  var sunDir       : h3d.Vector;
  var totalKillDist: Float = 0.0;
  var totalKills   : Int = 0;

  var rockets      : Array<Rocket>      = [];
  var rTrails      : Array<RocketTrail> = [];
  var fadingTrails : Array<RocketTrail> = [];
  var explosions   : Array<Explosion>   = [];
  var balls        : Array<BallTarget>  = [];
  var debris       : Array<BallDebris>  = [];
  var fragMessages : Array<FragMessage> = [];
  var indicators   : Array<EnemyIndicator> = [];
  var jumpDusts    : Array<JumpDust> = [];
  var jetpackParticles : Array<JetpackParticles> = [];
  var damageNumbers : Array<DamageNumber> = [];

  static inline var BALL_SPAWN_INTERVAL = 2.5;  // seconds between spawns
  static inline var BALL_MAX            = 20;
  var ballTimer    : Float = 0.0;

  var keys : hxd.Key;

  public function new(s3d: h3d.scene.Scene, s2d: h2d.Scene, engine: h3d.Engine) {
    this.s3d    = s3d;
    this.s2d    = s2d;
    this.engine = engine;

    terrain = new Terrain(s3d);
    sky     = new Sky(s3d);
    engine.backgroundColor = 0x00000000;
    
    // Initialize network connection
    #if js
    network = new NetworkManager('ws://localhost:8095');
    network.setOnMessage(handleNetworkMessage);
    network.onConnect(function(playerId) {
      js.Browser.console.log('Connected as player: ' + playerId);
    });
    #end
    
    player  = new Player(s3d, s2d, terrain, network);
    player.setRemotePlayersRef(remotePlayers);
    
    // Initialize team scores
    teamScores.set(0, 0); // Red team
    teamScores.set(1, 0); // Blue team
    
    // Initialize round timer
    roundTimer = 0;
    
    weapon  = new WeaponModel(s3d);
    
    // Set up jump dust callback
    player.onJump = function(jumpPos: h3d.Vector) {
      jumpDusts.push(new JumpDust(s3d, jumpPos));
    };
    
    // Set up footstep dust callback (smaller effect)
    player.onFootstep = function(stepPos: h3d.Vector) {
      jumpDusts.push(new JumpDust(s3d, stepPos, 0.4));  // 40% intensity for subtle effect
    };
    
    // Set up jetpack particles callback
    player.onJetpack = function(jetPos: h3d.Vector) {
      jetpackParticles.push(new JetpackParticles(s3d, jetPos));
    };
    
    // Set up spectator cycle callback
    player.onSpectatorCycle = function() {
      player.cycleSpectatorTarget(remotePlayers);
    };

    // Spawn a handful of balls immediately (70% small, 20% medium, 10% large)
    for (i in 0...6) {
      var b = new BallTarget(s3d, terrain, pickVariant());
      balls.push(b);
      indicators.push(new EnemyIndicator(s2d, b));
    }

    // Directional sunlight
    sunDir = new h3d.Vector(0.4, -1, 0.6).normalized();
    var sun = new h3d.scene.fwd.DirLight(sunDir, s3d);
    sun.color.set(1.0, 0.95, 0.85);
    cast(s3d.lightSystem, h3d.scene.fwd.LightSystem).ambientLight.set(0.5, 0.52, 0.58);

    // Lock pointer on click
    #if js
    js.Browser.document.addEventListener("click", function(_) {
      if (js.Browser.document.pointerLockElement == null)
        js.Browser.document.querySelector("canvas").requestPointerLock();
    });
    #end

    // FPS counter in top right
    fpsText = new h2d.Text(hxd.res.DefaultFont.get(), s2d);
    fpsText.textColor = 0xFFFFFF;
    fpsText.textAlign = Right;
    fpsText.setPosition(engine.width - 10, 10);
    
    // Scoreboard (toggle with TAB)
    scoreboard = new h2d.Text(hxd.res.DefaultFont.get(), s2d);
    scoreboard.textColor = 0xFFFFFF;
    scoreboard.textAlign = Left;
    scoreboard.setPosition(10, 150);
    scoreboard.setScale(0.9);
    scoreboard.visible = false;
    scoreboard.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };

    // Stats display at top center
    statsText = new h2d.Text(hxd.res.DefaultFont.get(), s2d);
    statsText.textColor = 0xFFFFFF;
    statsText.textAlign = Center;
    statsText.setPosition(engine.width / 2, 10);

    // Player list (top left, below team indicator)
    playerListText = new h2d.Text(hxd.res.DefaultFont.get(), s2d);
    playerListText.textColor = 0x88FF88;
    playerListText.textAlign = Left;
    playerListText.setPosition(10, 185);
    playerListText.setScale(1.0);
    
    // Round timer (top right)
    roundTimerText = new h2d.Text(hxd.res.DefaultFont.get(), s2d);
    roundTimerText.textColor = 0xFFFFFF;
    roundTimerText.textAlign = Right;
    roundTimerText.setPosition(s2d.width - 10, 10);
    roundTimerText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    roundTimerText.setScale(1.2);
  }

  public function update(dt: Float) {
    // Update round timer
    roundTimer += dt;
    
    // Update network manager (ping, reconnect)
    if (network != null) {
      network.update(dt);
      
      // Detect disconnect and cleanup remote players
      if (wasConnected && !network.isConnected()) {
        wasConnected = false;
        js.Browser.console.log('Disconnected - clearing remote players');
        for (rp in remotePlayers) {
          rp.dispose();
        }
        remotePlayers = new Map();
        remoteRockets = new Map();
        remoteRocketTrails = new Map();
        playerScores = new Map();
      } else if (!wasConnected && network.isConnected()) {
        wasConnected = true;
      }
    }
    
    // Update FPS display
    fpsText.text = Std.string(Std.int(engine.fps));
    
    // Update round timer display (MM:SS format)
    var minutes = Std.int(roundTimer / 60);
    var seconds = Std.int(roundTimer % 60);
    var secStr = seconds < 10 ? "0" + Std.string(seconds) : Std.string(seconds);
    roundTimerText.text = Std.string(minutes) + ":" + secStr;

    // Update stats display
    statsText.text = Math.round(totalKillDist) + ' - ' + totalKills;

    // Update scoreboard
    if (hxd.Key.isDown(hxd.Key.TAB)) {
      scoreboard.visible = true;
      updateScoreboard();
    } else {
      scoreboard.visible = false;
    }

    // Update player list
    updatePlayerList();

    player.update(dt);
    
    // Handle spectator mode when dead
    if (player.isDead) {
      weapon.setVisible(false);
      var specTarget = player.getSpectatorTarget();
      if (specTarget != null) {
        // 3rd person spectator camera: behind and above player
        var yaw = specTarget.rotation.y;
        var dist = 8.0;  // distance behind player
        var height = 3.0; // height above player
        
        // Camera position: behind player based on their yaw
        var cx = specTarget.pos.x - Math.sin(yaw) * dist;
        var cy = specTarget.pos.y + height;
        var cz = specTarget.pos.z - Math.cos(yaw) * dist;
        
        s3d.camera.pos.set(cx, cy, cz);
        // Look at player
        s3d.camera.target.set(specTarget.pos.x, specTarget.pos.y + 1.5, specTarget.pos.z);
      } else {
        // Find first alive remote player to spectate
        for (rp in remotePlayers) {
          if (rp.health > 0) {
            player.setSpectatorTarget(rp);
            break;
          }
        }
      }
    } else {
      weapon.setVisible(true);
    }
    
    terrain.update(player.pos.x, player.pos.z);
    sky.update(s3d.camera);

    // Update weapon viewmodel (hide when dead)
    if (!player.isDead) {
      var spd = Math.sqrt(player.vel.x*player.vel.x + player.vel.z*player.vel.z);
      weapon.update(dt, s3d.camera, player.yaw, player.pitch, spd);
    }

    // Update fog camera position
    if (terrain.shader != null && terrain.shader.cameraPos != null) {
      var cam = s3d.camera;
      terrain.shader.cameraPos.set(cam.pos.x, cam.pos.y, cam.pos.z);
    }

    // Fire rocket
    if (player.wantsToFire()) {
      weapon.fire();
      var camPos = player.getCameraPos();
      var camDir = player.getCameraDir();
      var spawnPos = camPos.clone();
      spawnPos.x += camDir.x * 0.5;
      spawnPos.y += camDir.y * 0.5;
      spawnPos.z += camDir.z * 0.5;
      var r = new Rocket(s3d, spawnPos, camDir, player.getVelocity());
      rockets.push(r);
      rTrails.push(new RocketTrail(s3d));
      
      // Send rocket fire to network
      if (network != null && network.isConnected()) {
        network.sendRocketFire(
          {x: spawnPos.x, y: spawnPos.y, z: spawnPos.z},
          {x: camDir.x, y: camDir.y, z: camDir.z}
        );
      }
    }

    // Update rockets + feed trails
    var i = rockets.length;
    while (--i >= 0) {
      var r = rockets[i];
      var tr = rTrails[i];
      var px = r.prevPos.x; var py = r.prevPos.y; var pz = r.prevPos.z;
      r.update(dt, terrain);
      tr.addPoint(r.pos.x, r.pos.y, r.pos.z, px, py, pz);
      if (r.dead) {
        explosions.push(new Explosion(s3d, r.pos));
        
        // Client-side hit prediction for immediate feedback (favor attacker)
        for (rp in remotePlayers) {
          // Skip teammates
          if (rp.team == player.team) continue;
          
          var dx = r.pos.x - rp.pos.x;
          var dy = r.pos.y - rp.pos.y;
          var dz = r.pos.z - rp.pos.z;
          var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (dist < 5.0) { // Damage radius
            var damage = Math.round(50 * (1 - dist / 5.0));
            fragMessages.push(new FragMessage(s2d, 0, 'HIT! $damage'));
            
            // Show damage number popup on the target
            damageNumbers.push(new DamageNumber(s3d, s2d, rp.pos.x, rp.pos.y, rp.pos.z, damage));
            
            // Predict kill if damage would be fatal
            if (rp.health <= damage) {
              fragMessages.push(new FragMessage(s2d, 0, 'KILL PREDICTED!'));
            }
          }
        }
        
        // Send explosion to network for player damage calculation
        if (network != null && network.isConnected()) {
          network.sendRocketExplodeWithPlayer({x: r.pos.x, y: r.pos.y, z: r.pos.z});
        }
        // Apply knockback to player for rocket jumping
        var dx = player.pos.x - r.pos.x;
        var dy = player.pos.y - r.pos.y;
        var dz = player.pos.z - r.pos.z;
        var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist < 15.0) {  // within rocket jump range
          var force = 35.0 * (1.0 - dist / 15.0);  // falloff with distance
          player.applyKnockback(r.pos.x, r.pos.y, r.pos.z, force);
        }
        r.dispose();
        rockets.splice(i, 1);
        fadingTrails.push(rTrails.splice(i, 1)[0]); // hand off to fading list
      }
    }
    
    // Update remote rockets
    var rrKeys = [for (k in remoteRockets.keys()) k];
    var rri = 0;
    while (rri < rrKeys.length) {
      var rocketId = rrKeys[rri];
      var r = remoteRockets.get(rocketId);
      if (r != null) {
        r.update(dt, terrain);
        
        // Update trail for this remote rocket
        var trail = remoteRocketTrails.get(rocketId);
        if (trail != null) {
          trail.addPoint(r.pos.x, r.pos.y, r.pos.z, r.pos.x, r.pos.y, r.pos.z);
          trail.update(dt);
        }
        
        // Client-side collision prediction for remote rockets vs local player
        if (!player.isDead) {
          var dx = r.pos.x - player.pos.x;
          var dy = r.pos.y - player.pos.y;
          var dz = r.pos.z - player.pos.z;
          var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (dist < 2.0 && !r.dead) { // Hit radius
            r.dead = true;
            explosions.push(new Explosion(s3d, r.pos));
            
            // Predict damage for immediate feedback with direction indicator
            var predictedDamage = Math.round(50 * (1 - dist / 5.0));
            player.triggerDamageFlash(r.pos); // Pass rocket position for direction
            
            // Show damage number popup
            damageNumbers.push(new DamageNumber(s3d, s2d, player.pos.x, player.pos.y, player.pos.z, predictedDamage));
            
            // Predict death if damage would be fatal
            if (player.getHealth() <= predictedDamage) {
              player.predictDeath();
            }
            
            // Server will handle actual damage calculation
          }
        }
        
        if (r.dead) {
          explosions.push(new Explosion(s3d, r.pos));
          r.dispose();
          remoteRockets.remove(rocketId);
          if (trail != null) {
            trail.dispose();
            remoteRocketTrails.remove(rocketId);
          }
        }
      }
      rri++;
    }

    // Update active trails (still paired with live rockets)
    for (t in rTrails) t.update(dt);

    // Update fading trails (rocket already dead)
    var j = fadingTrails.length;
    while (--j >= 0) {
      fadingTrails[j].update(dt);
      if (fadingTrails[j].dead) {
        fadingTrails[j].dispose();
        fadingTrails.splice(j, 1);
      }
    }

    // Update explosions
    var k = explosions.length;
    while (--k >= 0) {
      var e = explosions[k];
      e.update(dt);
      if (e.dead) explosions.splice(k, 1);
    }

    // Spawn new balls over time (70% small, 20% medium, 10% large)
    ballTimer += dt;
    if (ballTimer >= BALL_SPAWN_INTERVAL && balls.length < BALL_MAX) {
      ballTimer = 0.0;
      var b = new BallTarget(s3d, terrain, pickVariant());
      balls.push(b);
      indicators.push(new EnemyIndicator(s2d, b));
    }

    // Update balls
    for (b in balls) b.update(dt, terrain, player.pos);

    // Update enemy indicators
    var bi = balls.length;
    while (--bi >= 0) {
      indicators[bi].update(player.pos, s3d.camera, engine.width, engine.height, player.yaw, player.pitch);
    }

    // Rocket vs ball collision
    var ri = rockets.length;
    while (--ri >= 0) {
      var r = rockets[ri];
      for (b in balls) {
        if (!b.dead && b.hitTest(r.pos.x, r.pos.y, r.pos.z, r.hitRadius)) {
          r.dead = true;
          if (b.takeDamage()) {
            // Ball destroyed
            // Calculate distance from fire point to hit point
            var dx = b.pos.x - r.firePos.x;
            var dy = b.pos.y - r.firePos.y;
            var dz = b.pos.z - r.firePos.z;
            var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            fragMessages.push(new FragMessage(s2d, dist));
            totalKillDist += dist;
            totalKills++;
          } else {
            // Ball damaged but not destroyed - apply knockback
            b.applyKnockback(r.pos.x, r.pos.y, r.pos.z, 40.0);
          }
          break;
        }
      }
      
      // Rocket vs remote player collision
      for (rp in remotePlayers) {
        var dx = r.pos.x - rp.pos.x;
        var dy = r.pos.y - rp.pos.y;
        var dz = r.pos.z - rp.pos.z;
        var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist < 2.0) {  // Hit radius for player
          r.dead = true;
          // Send explosion to server for damage calculation (no timestamp for remote rockets)
          if (network != null && network.isConnected()) {
            network.sendRocketExplodeWithPlayer({x: r.pos.x, y: r.pos.y, z: r.pos.z}, 0);
          }
          break;
        }
      }
    }

    // Remove dead balls -> spawn debris + explosion
    var bi = balls.length;
    while (--bi >= 0) {
      var b = balls[bi];
      if (b.dead) {
        // Remove indicator
        indicators[bi].dispose();
        indicators.splice(bi, 1);
        // Spawn debris
        explosions.push(new Explosion(s3d, b.pos));
        debris.push(new BallDebris(s3d, terrain, b.pos.x, b.pos.y, b.pos.z, b.cr, b.cg, b.cb, b.scale));
        b.dispose();
        balls.splice(bi, 1);
      }
    }

    // Update debris
    var di = debris.length;
    while (--di >= 0) {
      debris[di].update(dt);
      if (debris[di].dead) {
        debris[di].dispose();
        debris.splice(di, 1);
      }
    }
    
    // Update jump dust
    var jdi = jumpDusts.length;
    while (--jdi >= 0) {
      jumpDusts[jdi].update(dt);
      if (jumpDusts[jdi].dead) {
        jumpDusts[jdi].dispose();
        jumpDusts.splice(jdi, 1);
      }
    }
    
    // Update jetpack particles
    var jpi = jetpackParticles.length;
    while (--jpi >= 0) {
      jetpackParticles[jpi].update(dt);
      if (jetpackParticles[jpi].dead) {
        jetpackParticles[jpi].dispose();
        jetpackParticles.splice(jpi, 1);
      }
    }
    
    // Update damage numbers
    var dni = damageNumbers.length;
    while (--dni >= 0) {
      damageNumbers[dni].update(dt);
      if (damageNumbers[dni].dead) {
        damageNumbers[dni].dispose();
        damageNumbers.splice(dni, 1);
      }
    }

    // Update frag messages
    var fi = fragMessages.length;
    while (--fi >= 0) {
      fragMessages[fi].update(dt);
      if (fragMessages[fi].dead) {
        fragMessages.splice(fi, 1);
      }
    }
    
    // Update remote players
    for (rp in remotePlayers) {
      rp.update(dt, s3d.camera, s2d.width, s2d.height);
    }
  }
  
  function handleNetworkMessage(data: Dynamic) {
    switch (data.type) {
      case 'playerJoined':
        if (!remotePlayers.exists(data.playerId)) {
          var rp = new RemotePlayer(s3d, s2d, data.playerId, data.position.x, data.position.y, data.position.z, data.color, data.name);
          if (data.team != null) {
            rp.team = data.team;
            rp.updateTeamColor();
          }
          remotePlayers.set(data.playerId, rp);
          playerScores.set(data.playerId, 0); // Initialize score
          // Player joined - notification shown via frag message
          
          // Show join notification with team
          var teamStr = data.team == 0 ? '[RED]' : '[BLUE]';
          fragMessages.push(new FragMessage(s2d, 0, '${data.name} $teamStr joined'));
        }
      case 'playerUpdate':
        var rp = remotePlayers.get(data.playerId);
        if (rp != null && data.position != null && data.rotation != null) {
          rp.updatePosition(data.position.x, data.position.y, data.position.z);
          rp.updateRotation(data.rotation.x, data.rotation.y, data.rotation.z);
        }
      case 'playerLeft':
        var rp = remotePlayers.get(data.playerId);
        var playerName = rp != null ? rp.playerName : (data.name != null ? data.name : data.playerId.substr(0, 8));
        if (rp != null) {
          rp.dispose();
          remotePlayers.remove(data.playerId);
          playerScores.remove(data.playerId); // Remove from scoreboard
        }
        // Player left - notification shown via frag message
        
        // Show leave notification
        fragMessages.push(new FragMessage(s2d, 0, '$playerName left'));
      case 'playerNameChanged':
        // Update player name
        var rp = remotePlayers.get(data.playerId);
        if (rp != null) {
          var oldName = rp.playerName;
          rp.playerName = data.name;
          // Name changed - notification shown via frag message
          
          // Show rename notification
          fragMessages.push(new FragMessage(s2d, 0, '$oldName is now ${data.name}'));
        }
      case 'playerPosition':
        // Server reconciliation - update local player position with sequence acknowledgment
        var ackSeq = data.seq != null ? data.seq : -1;
        player.updateServerPosition(data.position.x, data.position.y, data.position.z, ackSeq);
      case 'init':
        // Initialize existing players
        var playersArray : Array<Dynamic> = data.players;
        for (p in playersArray) {
          if (p.id != network.getPlayerId() && !remotePlayers.exists(p.id)) {
            var rp = new RemotePlayer(s3d, s2d, p.id, p.position.x, p.position.y, p.position.z, p.color, p.name);
            if (p.team != null) {
              rp.team = p.team;
              rp.updateTeamColor();
            }
            remotePlayers.set(p.id, rp);
          }
        }
        
        // Set local player team
        if (data.team != null) {
          player.team = data.team;
        }
      case 'rocketFire':
        // Create remote rocket with trail
        var rocketId = data.playerId + '_' + Date.now();
        var spawnPos = new h3d.Vector(data.position.x, data.position.y, data.position.z);
        var dir = new h3d.Vector(data.direction.x, data.direction.y, data.direction.z);
        var r = new Rocket(s3d, spawnPos, dir, new h3d.Vector(0, 0, 0));
        remoteRockets.set(rocketId, r);
        var trail = new RocketTrail(s3d);
        trail.addPoint(spawnPos.x, spawnPos.y, spawnPos.z, spawnPos.x, spawnPos.y, spawnPos.z);
        remoteRocketTrails.set(rocketId, trail);
        
        // Trigger shooting indicator on the remote player
        var shooter = remotePlayers.get(data.playerId);
        if (shooter != null) {
          shooter.triggerShoot();
        }
      case 'rocketExplode':
        // Find and remove remote rocket, create explosion
        for (rocketId in remoteRockets.keys()) {
          var r = remoteRockets.get(rocketId);
          if (r != null) {
            explosions.push(new Explosion(s3d, r.pos));
            r.dispose();
            remoteRockets.remove(rocketId);
            var trail = remoteRocketTrails.get(rocketId);
            if (trail != null) {
              trail.dispose();
              remoteRocketTrails.remove(rocketId);
            }
            break;
          }
        }
      case 'takeDamage':
        // Apply damage to local player with direction indicator
        var fromPos = data.fromPosition != null ? new h3d.Vector(data.fromPosition.x, data.fromPosition.y, data.fromPosition.z) : null;
        player.takeDamage(data.damage, fromPos);
      case 'playerKilled':
        // Show kill message using names instead of IDs
        var killerName = data.killer;
        var victimName = data.victim;
        var killerRp = remotePlayers.get(data.killer);
        var victimRp = remotePlayers.get(data.victim);
        if (killerRp != null) killerName = killerRp.playerName;
        if (victimRp != null) victimName = victimRp.playerName;
        if (network != null && data.killer == network.getPlayerId()) killerName = 'YOU';
        if (network != null && data.victim == network.getPlayerId()) victimName = 'YOU';
        fragMessages.push(new FragMessage(s2d, 0, '$killerName killed $victimName'));
        
        // Update scoreboard for killer
        var currentKills = playerScores.get(data.killer);
        if (currentKills == null) currentKills = 0;
        playerScores.set(data.killer, currentKills + 1);
        
        // Hide the killed player
        var killedRp = remotePlayers.get(data.victim);
        if (killedRp != null) {
          killedRp.updateHealth(0); // Set health to 0
          killedRp.setDead(true); // Hide the player
        }
      case 'respawn':
        // Respawn at new location
        var startH = terrain.getHeight(data.position.x, data.position.z);
        player.pos.set(data.position.x, startH + 10, data.position.z);
        player.vel.set(0, 0, 0);
        player.resetHealth();
        // Respawned at new location
      case 'playerRespawned':
        // Show respawned player
        var respawnedRp = remotePlayers.get(data.playerId);
        if (respawnedRp != null) {
          respawnedRp.updateHealth(100);
          respawnedRp.setDead(false);
          respawnedRp.updatePosition(data.position.x, data.position.y, data.position.z);
        }
      case 'killCount':
        // Update local kill count
        player.addKill();
        if (network != null) {
          var localId = network.getPlayerId();
          var currentScore = playerScores.get(localId);
          if (currentScore == null) currentScore = 0;
          playerScores.set(localId, currentScore + 1);
        }
        // Kill count updated
      case 'teamScore':
        // Update team score
        teamScores.set(data.team, data.score);
      case 'gameOver':
        // Show game over message
        fragMessages.push(new FragMessage(s2d, 0, data.message));
      case 'gameReset':
        // Reset team scores
        teamScores.set(0, data.redScore);
        teamScores.set(1, data.blueScore);
        
        // Reset local player kills
        player.resetKills();
        
        // Reset round timer
        roundTimer = 0;
        
        // Show reset notification
        fragMessages.push(new FragMessage(s2d, 0, 'GAME RESET - NEW ROUND'));
      case 'countdown':
        // Show countdown message
        fragMessages.push(new FragMessage(s2d, 0, 'RESET IN: ${data.seconds}s'));
      case 'roundStart':
        // Show round start notification
        fragMessages.push(new FragMessage(s2d, 0, data.message));
      case 'hitConfirm':
        // Show hit marker only - prediction already showed the HIT message
        player.showHitMarker();
        // Hit confirmed - marker shown on screen
      case 'playerHealth':
        // Update remote player health
        var rp = remotePlayers.get(data.playerId);
        if (rp != null) {
          rp.updateHealth(data.health);
        }
      default:
    }
  }

  // Pick enemy variant: 0=small(70%), 1=medium(20%), 2=large(10%)
  function pickVariant() : Int {
    var r = Math.random();
    if (r < 0.70) return 0;  // 70% small
    if (r < 0.90) return 1;  // 20% medium
    return 2;                // 10% large
  }
  
  function updateScoreboard() {
    // Build scoreboard string
    var sb = new StringBuf();
    sb.add('TEAM DEATHMATCH\n');
    sb.add('--------------------------------\n');
    
    // Show team scores
    var redScore = teamScores.get(0);
    var blueScore = teamScores.get(1);
    sb.add('RED TEAM: $redScore\n');
    sb.add('BLUE TEAM: $blueScore\n');
    sb.add('--------------------------------\n');
    
    // Build sorted scores including local player
    var scores = new Array<{id: String, name: String, kills: Int, isLocal: Bool, team: Int}>();
    
    // Add local player
    if (network != null) {
      var localId = network.getPlayerId();
      var localKills = player.getKills();
      scores.push({id: localId, name: 'YOU', kills: localKills, isLocal: true, team: player.team});
    }
    
    // Add remote players from playerScores
    for (id in playerScores.keys()) {
      if (network != null && id == network.getPlayerId()) continue; // Skip local, already added
      var rp = remotePlayers.get(id);
      var name = rp != null ? rp.playerName : id.substr(0, 8);
      var team = rp != null ? rp.team : 0;
      scores.push({id: id, name: name, kills: playerScores.get(id), isLocal: false, team: team});
    }
    
    // Sort by kills descending
    scores.sort(function(a, b) return b.kills - a.kills);
    
    // Add all players with team indicator
    for (s in scores) {
      var teamStr = s.team == 0 ? '[RED]' : '[BLUE]';
      if (s.isLocal) {
        sb.add('YOU $teamStr: ${s.kills} kills\n');
      } else {
        sb.add('${s.name} $teamStr: ${s.kills} kills\n');
      }
    }
    
    sb.add('--------------------------------');
    scoreboard.text = sb.toString();
  }

  function updatePlayerList() {
    var sb = new StringBuf();
    sb.add('PLAYERS:\n');

    // Add local player
    sb.add('YOU: ${Math.round(player.getHealth())} HP\n');

    // Add remote players (use name if available)
    for (rp in remotePlayers) {
      var displayName = rp.playerName != null ? rp.playerName : rp.playerId.substr(0, 8);
      sb.add('$displayName: ${Math.round(rp.health)} HP\n');
    }

    playerListText.text = sb.toString();
  }

}
