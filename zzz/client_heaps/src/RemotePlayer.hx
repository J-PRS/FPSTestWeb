class RemotePlayer {
  
  var s3d : h3d.scene.Scene;
  var s2d : h2d.Scene;
  var bodyMesh : h3d.scene.Mesh;
  var headMesh : h3d.scene.Mesh;
  public var pos : h3d.Vector;
  var targetPos : h3d.Vector;
  var targetRotation : h3d.Vector;
  public var rotation : h3d.Vector;
  public var playerId : String;
  public var playerName : String;
  var color : h3d.Vector;
  var lastUpdateTime : Float = 0;
  public var health : Float = 100.0;
  var nameText : h2d.Text;
  var healthText : h2d.Text;
  public var isDead : Bool = false;
  public var team : Int = 0; // 0 = red, 1 = blue
  
  // Shooting indicator
  var shootTimer : Float = 0;
  static inline var SHOOT_DURATION = 0.15; // Duration of shoot indicator
  
  // Interpolation buffer for smoother movement
  var interpolationBuffer : Array<{pos: h3d.Vector, time: Float}> = [];
  static inline var BUFFER_SIZE = 4;
  static inline var INTERPOLATION_DELAY = 0.033; // 33ms delay (2 frames at 60Hz) for tighter feel
  
  public function new(s3d: h3d.scene.Scene, s2d: h2d.Scene, playerId: String, x: Float, y: Float, z: Float, ?colorData: {r:Int, g:Int, b:Int}, ?playerName: String) {
    this.s3d = s3d;
    this.s2d = s2d;
    this.playerId = playerId;
    this.playerName = playerName != null ? playerName : playerId.substr(0, 8);
    this.pos = new h3d.Vector(x, y, z);
    this.targetPos = new h3d.Vector(x, y, z);
    this.targetRotation = new h3d.Vector(0, 0, 0);
    this.rotation = new h3d.Vector(0, 0, 0);
    
    // Use team color
    color = team == 0 ? new h3d.Vector(1.0, 0.2, 0.2) : new h3d.Vector(0.2, 0.4, 1.0);
    
    // Create body capsule (upright)
    var bodyPrim = new h3d.prim.Capsule(0.4, 1.4, 8);
    bodyPrim.addNormals();
    bodyMesh = new h3d.scene.Mesh(bodyPrim, s3d);
    bodyMesh.material.color.set(color.x, color.y, color.z);
    bodyMesh.material.shadows = true;
    bodyMesh.setPosition(x, y + 0.7, z); // Center at mid-height
    // Capsule is upright by default, no rotation needed
    
    // Create head sphere (at top of body)
    var headPrim = new h3d.prim.Sphere(0.25, 16, 16);
    headPrim.addNormals();
    headMesh = new h3d.scene.Mesh(headPrim, s3d);
    headMesh.material.color.set(color.x * 0.9, color.y * 0.9, color.z * 0.9); // Slightly lighter
    headMesh.material.shadows = true;
    headMesh.setPosition(x, y + 1.6, z); // Top of 1.4m body + head radius
    
    // Create name label
    var font = hxd.res.DefaultFont.get();
    nameText = new h2d.Text(font, s2d);
    nameText.text = playerName; // Use player name
    nameText.textColor = 0xFFFFFF;
    nameText.textAlign = Center;
    nameText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    nameText.setScale(0.8);
    
    // Create health label
    healthText = new h2d.Text(font, s2d);
    healthText.text = '100';
    healthText.textColor = 0x44FF44;
    healthText.textAlign = Center;
    healthText.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    healthText.setScale(0.7);
  }
  
  public function update(dt: Float, camera: h3d.Camera, screenWidth: Float, screenHeight: Float) {
    // Skip update for dead players (labels already hidden by setDead)
    if (isDead) return;
    
    // Use interpolation buffer for smoother movement
    #if js
    var now = haxe.Timer.stamp();
    #else
    var now = Sys.time();
    #end
    
    // Clean old buffer entries
    while (interpolationBuffer.length > 0 && (now - interpolationBuffer[0].time) > 0.5) {
      interpolationBuffer.shift();
    }
    
    if (interpolationBuffer.length >= 2) {
      // Find two points to interpolate between
      var targetTime = now - INTERPOLATION_DELAY;
      var p1 = interpolationBuffer[0];
      var p2 = interpolationBuffer[1];
      
      // Find the correct pair
      var found = false;
      for (i in 0...interpolationBuffer.length - 1) {
        if (interpolationBuffer[i].time <= targetTime && interpolationBuffer[i + 1].time >= targetTime) {
          p1 = interpolationBuffer[i];
          p2 = interpolationBuffer[i + 1];
          found = true;
          break;
        }
      }
      
      // If no suitable pair found, use the most recent two
      if (!found && interpolationBuffer.length >= 2) {
        p1 = interpolationBuffer[interpolationBuffer.length - 2];
        p2 = interpolationBuffer[interpolationBuffer.length - 1];
      }
      
      // Interpolate between the two points
      var timeDiff = p2.time - p1.time;
      if (timeDiff > 0) {
        var t = (targetTime - p1.time) / timeDiff;
        t = Math.max(0, Math.min(1, t));
        
        pos.x = p1.pos.x + (p2.pos.x - p1.pos.x) * t;
        pos.y = p1.pos.y + (p2.pos.y - p1.pos.y) * t;
        pos.z = p1.pos.z + (p2.pos.z - p1.pos.z) * t;
      }
    } else {
      // Fallback to simple lerp if buffer not ready
      var dx = targetPos.x - pos.x;
      var dy = targetPos.y - pos.y;
      var dz = targetPos.z - pos.z;
      var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      
      var lerpSpeed = 5.0 + dist * 2.0;
      var lerp = lerpSpeed * dt;
      
      pos.x += dx * Math.min(lerp, 1.0);
      pos.y += dy * Math.min(lerp, 1.0);
      pos.z += dz * Math.min(lerp, 1.0);
    }
    
    // Smooth rotation interpolation
    var rotLerp = 8.0 * dt;
    rotation.x += (targetRotation.x - rotation.x) * Math.min(rotLerp, 1.0);
    rotation.y += (targetRotation.y - rotation.y) * Math.min(rotLerp, 1.0);
    rotation.z += (targetRotation.z - rotation.z) * Math.min(rotLerp, 1.0);
    
    bodyMesh.setPosition(pos.x, pos.y + 0.7, pos.z);
    headMesh.setPosition(pos.x, pos.y + 1.6, pos.z);
    
    // Apply rotation (yaw only)
    bodyMesh.setRotation(0, rotation.y, 0);
    headMesh.setRotation(0, rotation.y, 0);
    
    // Update shooting indicator
    if (shootTimer > 0) {
      shootTimer -= dt;
      // Flash white when shooting
      var flashIntensity = shootTimer / SHOOT_DURATION;
      var baseColor = color;
      bodyMesh.material.color.set(
        baseColor.x + (1.0 - baseColor.x) * flashIntensity,
        baseColor.y + (1.0 - baseColor.y) * flashIntensity,
        baseColor.z + (1.0 - baseColor.z) * flashIntensity
      );
    } else {
      // Return to normal color
      bodyMesh.material.color.set(color.x, color.y, color.z);
    }
    
    // Project 3D position to 2D screen space for labels
    var worldPos = new h3d.Vector(pos.x, pos.y + 2.2, pos.z); // Above head

    // Get camera direction from target
    var camDir = new h3d.Vector();
    camDir.x = camera.target.x - camera.pos.x;
    camDir.y = camera.target.y - camera.pos.y;
    camDir.z = camera.target.z - camera.pos.z;
    camDir.normalize();

    // Calculate camera yaw and pitch
    var camYaw = Math.atan2(camDir.x, camDir.z);
    var camPitch = Math.asin(camDir.y);

    // Compute camera basis (same as EnemyIndicator)
    var cp = Math.cos(camPitch);
    var sp = Math.sin(camPitch);
    var cy = Math.cos(camYaw);
    var sy = Math.sin(camYaw);

    // Forward
    var fx = cp * sy;
    var fy = sp;
    var fz = cp * cy;

    // Right
    var rx = cy;
    var rz = -sy;

    // Up
    var ux = -sp * sy;
    var uy = cp;
    var uz = -sp * cy;

    // Transform offset to camera space
    var dx = worldPos.x - camera.pos.x;
    var dy = worldPos.y - camera.pos.y;
    var dz = worldPos.z - camera.pos.z;

    var cx = dx * rx + dy * ux + dz * rz;  // right component
    var cy_cam = dx * ux + dy * uy + dz * uz;  // up component
    var cz = dx * fx + dy * fy + dz * fz;  // forward component

    // Check if in front of camera
    if (cz > 0.1) {
      // Project to screen using perspective (same as EnemyIndicator)
      var fovTan = Math.tan(camera.fovY * Math.PI / 360.0);
      var aspect = screenWidth / screenHeight;
      var sx = (cx / cz) / (fovTan * aspect);
      var sy = (cy_cam / cz) / fovTan;

      // Convert to screen pixel coordinates
      var screenX = screenWidth * 0.5 + sx * screenWidth * 0.5;
      var screenY = screenHeight * 0.5 - sy * screenHeight * 0.5;  // flip Y
      
      // Show if on screen
      if (sx > 0 && sx < screenWidth && sy > 0 && sy < screenHeight) {
        nameText.x = sx;
        nameText.y = sy;
        nameText.visible = true;
        
        healthText.x = sx;
        healthText.y = sy + 15;
        healthText.visible = true;
        
        // Update health color based on value
        if (health > 60) {
          healthText.textColor = 0x44FF44; // Green
        } else if (health > 30) {
          healthText.textColor = 0xFFFF44; // Yellow
        } else {
          healthText.textColor = 0xFF4444; // Red
        }
      } else {
        nameText.visible = false;
        healthText.visible = false;
      }
    } else {
      nameText.visible = false;
      healthText.visible = false;
    }
  }
  
  public function updatePosition(x: Float, y: Float, z: Float) {
    targetPos.set(x, y, z);
    
    // Add to interpolation buffer
    #if js
    var now = haxe.Timer.stamp();
    #else
    var now = Sys.time();
    #end
    interpolationBuffer.push({
      pos: new h3d.Vector(x, y, z),
      time: now
    });
    
    // Keep buffer size limited
    if (interpolationBuffer.length > BUFFER_SIZE) {
      interpolationBuffer.shift();
    }
  }
  
  public function updateRotation(x: Float, y: Float, z: Float) {
    targetRotation.set(x, y, z);
  }
  
  public function triggerShoot() {
    shootTimer = SHOOT_DURATION;
  }
  
  public function updateTeamColor() {
    var newColor = team == 0 ? new h3d.Vector(1.0, 0.2, 0.2) : new h3d.Vector(0.2, 0.4, 1.0);
    color.set(newColor.x, newColor.y, newColor.z);
    
    if (bodyMesh != null) {
      bodyMesh.material.color.set(color.x, color.y, color.z);
    }
    if (headMesh != null) {
      headMesh.material.color.set(color.x * 0.9, color.y * 0.9, color.z * 0.9);
    }
  }
  
  public function updateHealth(newHealth: Float) {
    health = newHealth;
    healthText.text = Std.string(Math.round(health));
  }
  
  public function setDead(dead: Bool) {
    isDead = dead;
    if (bodyMesh != null) bodyMesh.visible = !dead;
    if (headMesh != null) headMesh.visible = !dead;
    if (nameText != null) nameText.visible = !dead;
    if (healthText != null) healthText.visible = !dead;
  }
  
  public function dispose() {
    bodyMesh.remove();
    headMesh.remove();
    nameText.remove();
    healthText.remove();
  }
  
  public function getId() : String {
    return playerId;
  }
}
